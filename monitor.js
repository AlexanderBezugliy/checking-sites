const fs = require("fs");
const { Resolver } = require("node:dns").promises;
const { sendTelegram } = require("./telegram");

const DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];
const DNS_TIMEOUT_MS = 8000;
const HTTP_TIMEOUT_MS = 10000;
const BATCH_SIZE = 25;

function getHttpDesc(status) {
    const codes = {
        400: "Bad Request",
        401: "Unauthorized",
        403: "Forbidden / Access Denied",
        404: "Not Found",
        500: "Internal Server Error",
        502: "Bad Gateway",
        504: "Gateway Timeout",
    };
    return codes[status] || "";
}

function getHostname(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error(`${label} timeout`);
            err.code = "ETIMEOUT";
            reject(err);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function dnsErrorMessage(err) {
    const code = String(err.code || "").toUpperCase();
    const msg = String(err.message || "").toLowerCase();

    if (
        code === "ENOTFOUND" ||
        code === "ENODATA" ||
        code === "NXDOMAIN" ||
        msg.includes("nxdomain")
    ) {
        return "домен не резолвится";
    }
    if (
        code === "ESERVFAIL" ||
        code === "SERVFAIL" ||
        msg.includes("servfail")
    ) {
        return "NS не отвечают (SERVFAIL)";
    }
    if (code === "ETIMEOUT" || msg.includes("timeout")) {
        return "таймаут DNS";
    }
    if (code === "ECONNREFUSED" || msg.includes("econnrefused")) {
        return "DNS-резолвер недоступен";
    }
    return err.message || "ошибка DNS";
}

function isResolverUnreachable(err) {
    const code = String(err?.code || "").toUpperCase();
    return (
        code === "ECONNREFUSED" ||
        code === "ESOCKET" ||
        code === "ETIMEOUT"
    );
}

async function resolveRecords(resolver, method, hostname) {
    try {
        const records = await withTimeout(
            resolver[method](hostname),
            DNS_TIMEOUT_MS,
            method,
        );
        return { records: records || [], error: null };
    } catch (err) {
        return { records: [], error: err };
    }
}

async function lookupDns(hostname, servers) {
    const resolver = new Resolver();
    if (servers) resolver.setServers(servers);

    const nsResult = await resolveRecords(resolver, "resolveNs", hostname);
    const aResult = await resolveRecords(resolver, "resolve4", hostname);
    let aaaaResult = { records: [], error: null };
    if (!aResult.records.length) {
        aaaaResult = await resolveRecords(resolver, "resolve6", hostname);
    }

    return { nsResult, aResult, aaaaResult };
}

async function checkDns(hostname) {
    const result = { ns: [], a: [], ok: false, error: null };

    try {
        let lookup = await lookupDns(hostname, DNS_SERVERS);
        const resolverFailed =
            !lookup.nsResult.records.length &&
            !lookup.aResult.records.length &&
            !lookup.aaaaResult.records.length &&
            [
                lookup.nsResult.error,
                lookup.aResult.error,
                lookup.aaaaResult.error,
            ].some(isResolverUnreachable);
        if (resolverFailed) {
            lookup = await lookupDns(hostname, null);
        }

        result.ns = lookup.nsResult.records;
        result.a = lookup.aResult.records.length
            ? lookup.aResult.records
            : lookup.aaaaResult.records;

        if (result.a.length) {
            result.ok = true;
            return result;
        }

        const failErr =
            lookup.aaaaResult.error ||
            lookup.aResult.error ||
            lookup.nsResult.error;
        if (!result.ns.length && lookup.nsResult.error) {
            result.error =
                dnsErrorMessage(lookup.nsResult.error) === "домен не резолвится"
                    ? "NS не найдены"
                    : dnsErrorMessage(lookup.nsResult.error);
        } else if (!result.ns.length) {
            result.error = "NS не найдены";
        } else {
            result.error = failErr
                ? dnsErrorMessage(failErr)
                : "A/AAAA записи не найдены";
        }
        return result;
    } catch (err) {
        result.error = dnsErrorMessage(err);
        return result;
    }
}

function isCloakOrOk(status) {
    return status === 200 || status === 503;
}

async function runMonitor() {
    const sites = JSON.parse(fs.readFileSync("./sites.json", "utf8"));
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

    const results = [];
    const failures = [];

    for (let i = 0; i < sites.length; i += BATCH_SIZE) {
        const batch = sites.slice(i, i + BATCH_SIZE);

        const promises = batch.map(async (site) => {
            const startTime = Date.now();
            const hostname = getHostname(site.url);
            const dns = hostname
                ? await checkDns(hostname)
                : {
                      ns: [],
                      a: [],
                      ok: false,
                      error: "некорректный URL",
                  };

            if (!dns.ok) {
                results.push({
                    url: site.url,
                    status: "DNS_ERROR",
                    ok: false,
                    alive: false,
                    dns,
                    error: dns.error,
                });
                failures.push(`🧭 *${site.url}* — ${dns.error}`);
                return;
            }

            try {
                const response = await fetch(site.url, {
                    method: "GET",
                    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
                });

                const duration = Date.now() - startTime;
                const alive = isCloakOrOk(response.status);
                results.push({
                    url: site.url,
                    status: response.status,
                    ok: response.ok,
                    alive,
                    duration,
                    dns,
                });

                // 503 — клоака, это нормально, если DNS живой
                if (!alive) {
                    const desc = getHttpDesc(response.status);
                    const statusText = desc
                        ? `HTTP ${response.status} (${desc})`
                        : `HTTP ${response.status}`;
                    failures.push(`❌ *${site.url}* — ${statusText}`);
                }
            } catch (error) {
                const errContext =
                    `${error.message} ${error.cause?.message || ""} ${error.cause?.code || ""}`.toLowerCase();
                const isSslError =
                    errContext.includes("cert") ||
                    errContext.includes("expired") ||
                    errContext.includes("tls");

                results.push({
                    url: site.url,
                    status: isSslError ? "SSL_ERROR" : "ERROR",
                    ok: false,
                    alive: false,
                    duration: Date.now() - startTime,
                    dns,
                    error: error.message,
                });

                if (isSslError) {
                    failures.push(`🔒 *${site.url}* — Истёк SSL-сертификат!`);
                } else {
                    failures.push(
                        `🚨 *${site.url}* — Ошибка: ${error.message}`,
                    );
                }
            }
        });

        await Promise.allSettled(promises);
    }

    const aliveCount = results.filter((r) => r.alive).length;
    const statusData = {
        last_update: new Date().toISOString(),
        total_sites: sites.length,
        alive_count: aliveCount,
        failed_count: failures.length,
        data: results,
    };
    fs.writeFileSync("./status.json", JSON.stringify(statusData, null, 2));

    if (BOT_TOKEN && CHAT_ID) {
        const slow = [...results]
            .filter(
                (r) =>
                    r.status !== "ERROR" &&
                    r.status !== "SSL_ERROR" &&
                    r.status !== "DNS_ERROR",
            )
            .sort((a, b) => (b.duration || 0) - (a.duration || 0))
            .slice(0, 3)
            .map(
                (r) =>
                    `   • ${r.url.replace("https://", "")} — ${r.duration}ms`,
            )
            .join("\n");

        const slowBlock = slow ? `\n\n⏱ Топ медленных:\n${slow}` : "";
        let message;
        if (failures.length > 0) {
            message = `⚠️ *Обнаружены проблемы со статусом сайтов (${failures.length}/${sites.length}):*\n\n${failures.join("\n")}\n\n✅ Живые (DNS + 200/503): ${aliveCount}${slowBlock}`;
        } else {
            message = `✅ *Все сайты работают стабильно (${sites.length}/${sites.length})*${slowBlock}`;
        }

        try {
            await sendTelegram({
                token: BOT_TOKEN,
                chatId: CHAT_ID,
                text: message,
                replyMarkup: {
                    inline_keyboard: [
                        [
                            {
                                text: "🔄 Проверить статус сейчас",
                                callback_data: "check_now",
                            },
                        ],
                    ],
                },
            });
            console.log("Сообщение отправлено в Telegram");
        } catch (tgError) {
            console.error("Ошибка отправки в TG:", tgError);
        }
    } else {
        console.log(
            "TELEGRAM_BOT_TOKEN/CHAT_ID не заданы — пропускаем отправку",
        );
    }
}

runMonitor().catch((err) => {
    console.error("Монитор упал:", err);
    process.exit(1);
});
