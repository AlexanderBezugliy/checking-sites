const fs = require("fs");
const tls = require("node:tls");
const { Resolver } = require("node:dns").promises;
const { sendTelegram } = require("./telegram");

const DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];
const DNS_TIMEOUT_MS = 8000;
const HTTP_TIMEOUT_MS = 10000;
const SSL_TIMEOUT_MS = 8000;
const BATCH_SIZE = 25;
const SSL_WARN_DAYS = 7;
const DIGEST_EVERY_MS = 12 * 60 * 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const STATUS_PATH = "./status.json";

const TG_KEYBOARD = {
    inline_keyboard: [
        [{ text: "🔄 Проверить статус сейчас", callback_data: "check_now" }],
    ],
};

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

function loadJson(path, fallback) {
    try {
        if (!fs.existsSync(path)) return fallback;
        return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
        return fallback;
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

function normalizeHost(host) {
    return String(host || "")
        .toLowerCase()
        .replace(/\.$/, "")
        .replace(/^www\./, "");
}

function nsKey(ns) {
    return (ns || [])
        .map((name) => String(name).toLowerCase().replace(/\.$/, ""))
        .sort()
        .join(",");
}

function isForeignRedirect(fromUrl, location) {
    if (!location) return false;
    try {
        const dest = new URL(location, fromUrl);
        const src = new URL(fromUrl);
        if (dest.protocol !== "http:" && dest.protocol !== "https:") {
            return false;
        }
        return normalizeHost(src.hostname) !== normalizeHost(dest.hostname);
    } catch {
        return false;
    }
}

function getSslExpiry(hostname) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const socket = tls.connect(
            {
                host: hostname,
                port: 443,
                servername: hostname,
                rejectUnauthorized: false,
            },
            () => {
                const cert = socket.getPeerCertificate();
                socket.end();
                if (!cert || !cert.valid_to) {
                    finish({ daysLeft: null, validTo: null, error: "no cert" });
                    return;
                }
                const validTo = new Date(cert.valid_to);
                if (Number.isNaN(validTo.getTime())) {
                    finish({
                        daysLeft: null,
                        validTo: null,
                        error: "bad cert date",
                    });
                    return;
                }
                const daysLeft = Math.ceil(
                    (validTo.getTime() - Date.now()) / 86400000,
                );
                finish({
                    daysLeft,
                    validTo: validTo.toISOString(),
                    error: null,
                });
            },
        );

        socket.setTimeout(SSL_TIMEOUT_MS, () => {
            socket.destroy();
            finish({ daysLeft: null, validTo: null, error: "timeout" });
        });
        socket.on("error", (err) => {
            finish({
                daysLeft: null,
                validTo: null,
                error: err.message,
            });
        });
    });
}

function shortUrl(url) {
    return String(url).replace(/^https?:\/\//, "");
}

function failureLine(row) {
    if (row.status === "DNS_ERROR") {
        return `🧭 *${row.url}* — ${row.error}`;
    }
    if (row.status === "SSL_ERROR") {
        return `🔒 *${row.url}* — Истёк SSL-сертификат!`;
    }
    if (row.redirect?.foreign) {
        return `↪️ *${row.url}* → ${row.redirect.location}`;
    }
    if (row.status === "ERROR") {
        return `🚨 *${row.url}* — Ошибка: ${row.error}`;
    }
    const desc = getHttpDesc(row.status);
    const statusText = desc
        ? `HTTP ${row.status} (${desc})`
        : `HTTP ${row.status}`;
    return `❌ *${row.url}* — ${statusText}`;
}

function prevByUrl(prevStatus) {
    const map = new Map();
    for (const row of prevStatus.data || []) {
        if (row?.url) map.set(row.url, row);
    }
    return map;
}

function wasSslWarnWindow(prev) {
    const days = prev?.ssl?.daysLeft;
    return days != null && days >= 0 && days <= SSL_WARN_DAYS;
}

function buildDiff(prevMap, results) {
    const down = [];
    const recovered = [];
    const nsChanged = [];
    const sslSoon = [];
    const redirects = [];

    for (const curr of results) {
        const prev = prevMap.get(curr.url);

        if (!curr.alive) {
            if (!prev || prev.alive) down.push(curr);
        } else if (prev && prev.alive === false) {
            recovered.push(curr);
        }

        if (prev?.dns?.ns?.length && curr.dns?.ns?.length) {
            if (nsKey(prev.dns.ns) !== nsKey(curr.dns.ns)) {
                nsChanged.push({
                    url: curr.url,
                    from: prev.dns.ns,
                    to: curr.dns.ns,
                });
            }
        }

        if (
            curr.ssl &&
            curr.ssl.daysLeft != null &&
            curr.ssl.daysLeft >= 0 &&
            curr.ssl.daysLeft <= SSL_WARN_DAYS &&
            !wasSslWarnWindow(prev)
        ) {
            sslSoon.push(curr);
        }

        if (curr.redirect?.foreign && !prev?.redirect?.foreign) {
            redirects.push(curr);
        }
    }

    return { down, recovered, nsChanged, sslSoon, redirects };
}

function diffHasEvents(diff) {
    return (
        diff.down.length ||
        diff.recovered.length ||
        diff.nsChanged.length ||
        diff.sslSoon.length ||
        diff.redirects.length
    );
}

function formatNsList(ns) {
    return (ns || []).map((name) => name.replace(/\.$/, "")).join(", ");
}

function buildChangeMessage(diff) {
    const blocks = ["⚠️ *Изменения по сайтам:*"];

    if (diff.down.length) {
        blocks.push(
            `\n📉 *Упали (${diff.down.length}):*`,
            ...diff.down.map(failureLine),
        );
    }
    if (diff.recovered.length) {
        blocks.push(
            `\n✅ *Ожили (${diff.recovered.length}):*`,
            ...diff.recovered.map((row) => `   • ${row.url}`),
        );
    }
    if (diff.redirects.length) {
        blocks.push(
            `\n↪️ *Чужой редирект (${diff.redirects.length}):*`,
            ...diff.redirects.map(
                (row) =>
                    `   • ${row.url} → ${row.redirect.location}`,
            ),
        );
    }
    if (diff.nsChanged.length) {
        blocks.push(
            `\n🧭 *Сменились NS (${diff.nsChanged.length}):*`,
            ...diff.nsChanged.map(
                (row) =>
                    `   • ${row.url}\n     было: ${formatNsList(row.from)}\n     стало: ${formatNsList(row.to)}`,
            ),
        );
    }
    if (diff.sslSoon.length) {
        blocks.push(
            `\n🔒 *SSL истекает за ${SSL_WARN_DAYS} дней (${diff.sslSoon.length}):*`,
            ...diff.sslSoon.map(
                (row) =>
                    `   • ${row.url} — ${row.ssl.daysLeft} дн. (до ${String(row.ssl.validTo).slice(0, 10)})`,
            ),
        );
    }

    return blocks.join("\n");
}

function slowBlock(results) {
    const slow = [...results]
        .filter(
            (r) =>
                r.status !== "ERROR" &&
                r.status !== "SSL_ERROR" &&
                r.status !== "DNS_ERROR" &&
                r.duration,
        )
        .sort((a, b) => (b.duration || 0) - (a.duration || 0))
        .slice(0, 3)
        .map((r) => `   • ${shortUrl(r.url)} — ${r.duration}ms`)
        .join("\n");
    return slow ? `\n\n⏱ Топ медленных:\n${slow}` : "";
}

function buildDigestMessage(results, sitesCount, aliveCount) {
    const http200 = results.filter((r) => r.status === 200).length;
    const cloak503 = results.filter((r) => r.status === 503).length;
    return `✅ *Всё тихо: ${aliveCount}/${sitesCount} живые* (DNS + 200/503)\nHTTP 200: ${http200} | клоака 503: ${cloak503}${slowBlock(results)}`;
}

async function notifyTelegram(token, chatId, text) {
    await sendTelegram({
        token,
        chatId,
        text,
        replyMarkup: TG_KEYBOARD,
    });
}

async function checkSite(site) {
    const startTime = Date.now();
    const hostname = getHostname(site.url);
    const dns = hostname
        ? await checkDns(hostname)
        : { ns: [], a: [], ok: false, error: "некорректный URL" };

    if (!dns.ok) {
        return {
            url: site.url,
            status: "DNS_ERROR",
            ok: false,
            alive: false,
            dns,
            error: dns.error,
            ssl: null,
            redirect: null,
        };
    }

    try {
        const response = await fetch(site.url, {
            method: "GET",
            redirect: "manual",
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });

        const duration = Date.now() - startTime;
        const location = response.headers.get("location");
        const redirect = REDIRECT_STATUSES.has(response.status)
            ? {
                  status: response.status,
                  location,
                  foreign: isForeignRedirect(site.url, location),
              }
            : null;

        let alive;
        if (redirect?.foreign) {
            alive = false;
        } else if (redirect) {
            alive = true;
        } else {
            alive = isCloakOrOk(response.status);
        }

        let ssl = null;
        if (hostname && alive) {
            try {
                ssl = await getSslExpiry(hostname);
            } catch {
                ssl = null;
            }
        }

        return {
            url: site.url,
            status: response.status,
            ok: response.ok,
            alive,
            duration,
            dns,
            ssl,
            redirect,
        };
    } catch (error) {
        const errContext =
            `${error.message} ${error.cause?.message || ""} ${error.cause?.code || ""}`.toLowerCase();
        const isSslError =
            errContext.includes("cert") ||
            errContext.includes("expired") ||
            errContext.includes("tls");

        return {
            url: site.url,
            status: isSslError ? "SSL_ERROR" : "ERROR",
            ok: false,
            alive: false,
            duration: Date.now() - startTime,
            dns,
            ssl: null,
            redirect: null,
            error: error.message,
        };
    }
}

async function runMonitor() {
    const sites = JSON.parse(fs.readFileSync("./sites.json", "utf8"));
    const prevStatus = loadJson(STATUS_PATH, { data: [] });
    const prevMap = prevByUrl(prevStatus);
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    const isManual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";

    const results = [];

    for (let i = 0; i < sites.length; i += BATCH_SIZE) {
        const batch = sites.slice(i, i + BATCH_SIZE);
        const settled = await Promise.allSettled(batch.map(checkSite));
        for (const item of settled) {
            if (item.status === "fulfilled") {
                results.push(item.value);
            } else {
                results.push({
                    url: "unknown",
                    status: "ERROR",
                    ok: false,
                    alive: false,
                    dns: { ns: [], a: [], ok: false, error: String(item.reason) },
                    error: String(item.reason),
                    ssl: null,
                    redirect: null,
                });
            }
        }
    }

    const aliveCount = results.filter((r) => r.alive).length;
    const failedCount = results.filter((r) => !r.alive).length;
    const diff = buildDiff(prevMap, results);
    const hasChanges = Boolean(diffHasEvents(diff));

    const now = Date.now();
    const lastDigestAt = prevStatus.last_digest_at
        ? Date.parse(prevStatus.last_digest_at)
        : 0;
    const digestDue =
        !Number.isFinite(lastDigestAt) ||
        now - lastDigestAt >= DIGEST_EVERY_MS;

    let sentDigest = false;

    if (BOT_TOKEN && CHAT_ID) {
        try {
            if (hasChanges) {
                await notifyTelegram(
                    BOT_TOKEN,
                    CHAT_ID,
                    buildChangeMessage(diff) + slowBlock(results),
                );
                console.log("Telegram: отправлен дифф изменений");
            } else if (isManual) {
                await notifyTelegram(
                    BOT_TOKEN,
                    CHAT_ID,
                    buildDigestMessage(results, sites.length, aliveCount) +
                        "\n\n_ручной запуск, изменений нет_",
                );
                sentDigest = true;
                console.log("Telegram: ручной запуск без изменений");
            } else if (digestDue) {
                await notifyTelegram(
                    BOT_TOKEN,
                    CHAT_ID,
                    buildDigestMessage(results, sites.length, aliveCount),
                );
                sentDigest = true;
                console.log("Telegram: дайджест «всё тихо»");
            } else {
                console.log("Telegram: без изменений, дайджест ещё не нужен");
            }
        } catch (tgError) {
            console.error("Ошибка отправки в TG:", tgError);
        }
    } else {
        console.log(
            "TELEGRAM_BOT_TOKEN/CHAT_ID не заданы — пропускаем отправку",
        );
    }

    const statusData = {
        last_update: new Date().toISOString(),
        last_digest_at: sentDigest
            ? new Date().toISOString()
            : prevStatus.last_digest_at || null,
        total_sites: sites.length,
        alive_count: aliveCount,
        failed_count: failedCount,
        data: results,
    };
    fs.writeFileSync(STATUS_PATH, JSON.stringify(statusData, null, 2));
}

runMonitor().catch((err) => {
    console.error("Монитор упал:", err);
    process.exit(1);
});
