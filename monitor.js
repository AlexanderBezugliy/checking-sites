const fs = require("fs");

// Хелпер для расшифровки точных HTTP статусов
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

async function runMonitor() {
    const sites = JSON.parse(fs.readFileSync("./sites.json", "utf8"));
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

    const results = [];
    const failures = [];
    const BATCH_SIZE = 25;

    for (let i = 0; i < sites.length; i += BATCH_SIZE) {
        const batch = sites.slice(i, i + BATCH_SIZE);

        const promises = batch.map(async (site) => {
            const startTime = Date.now();
            try {
                const response = await fetch(site.url, {
                    method: "GET",
                    signal: AbortSignal.timeout(10000),
                });

                const duration = Date.now() - startTime;
                results.push({
                    url: site.url,
                    status: response.status,
                    ok: response.ok,
                    duration,
                });

                // Проверяем на ошибки, полностью игнорируя статус 503 (клоака)
                if (!response.ok && response.status !== 503) {
                    const desc = getHttpDesc(response.status);
                    const statusText = desc
                        ? `HTTP ${response.status} (${desc})`
                        : `HTTP ${response.status}`;
                    failures.push(`❌ *${site.url}* — ${statusText}`);
                }
            } catch (error) {
                // Анализируем текст ошибки и системный код для поиска проблем с SSL
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

    const statusData = {
        last_update: new Date().toISOString(),
        total_sites: sites.length,
        failed_count: failures.length,
        data: results,
    };
    fs.writeFileSync("./status.json", JSON.stringify(statusData, null, 2));

    if (BOT_TOKEN && CHAT_ID) {
        const okCount = results.filter((r) => r.ok).length;
        const slow = [...results]
            .filter((r) => r.status !== "ERROR" && r.status !== "SSL_ERROR")
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 3)
            .map(
                (r) =>
                    `   • ${r.url.replace("https://", "")} — ${r.duration}ms`,
            )
            .join("\n");

        let message;
        // Изменили заголовки сообщений — убрали вывод времени
        if (failures.length > 0) {
            message = `⚠️ *Обнаружены проблемы со статусом сайтов (${failures.length}/${sites.length}):*\n\n${failures.join("\n")}\n\n✅ Работают штатно: ${okCount}\n⏱ Топ медленных:\n${slow}`;
        } else {
            message = `✅ *Все сайты работают стабильно (${sites.length}/${sites.length})*\n\n⏱ Топ медленных:\n${slow}`;
        }

        try {
            await fetch(
                `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        chat_id: CHAT_ID,
                        text: message,
                        parse_mode: "Markdown",
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: "🔄 Проверить статус сейчас",
                                        callback_data: "check_now",
                                    },
                                ],
                            ],
                        },
                    }),
                },
            );
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

runMonitor();
