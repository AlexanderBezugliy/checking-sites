const fs = require("fs");

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

                // ИЗМЕНЕНИЕ ЗДЕСЬ: шлем алерт, только если статус не OK И это НЕ 503 ошибка
                if (!response.ok && response.status !== 503) {
                    failures.push(`❌ *${site.url}* — HTTP ${response.status}`);
                }
            } catch (error) {
                results.push({
                    url: site.url,
                    status: "ERROR",
                    ok: false,
                    error: error.message,
                });
                failures.push(`🚨 *${site.url}* — Ошибка: ${error.message}`);
            }
        });

        await Promise.allSettled(promises);
    }

    // Счетчик завязан на массив failures, так что 503 сюда тоже теперь не попадет как сбой
    const statusData = {
        last_update: new Date().toISOString(),
        total_sites: sites.length,
        failed_count: failures.length,
        data: results,
    };
    fs.writeFileSync("./status.json", JSON.stringify(statusData, null, 2));

    if (BOT_TOKEN && CHAT_ID) {
        const time = new Date().toLocaleTimeString("ru-RU", {
            hour: "2-digit",
            minute: "2-digit",
        });
        const okCount = results.filter((r) => r.ok).length;
        const slow = [...results]
            .filter((r) => r.status !== "ERROR")
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 3)
            .map(
                (r) =>
                    `   • ${r.url.replace("https://", "")} — ${r.duration}ms`,
            )
            .join("\n");

        let message;
        if (failures.length > 0) {
            message = `⚠️ *Проверка ${time} — проблемы ${failures.length}/${sites.length}:*\n\n${failures.join("\n")}\n\n✅ Работают: ${okCount}\n⏱ Топ медленных:\n${slow}`;
        } else {
            message = `✅ *Проверка ${time} — всё ок (${sites.length}/${sites.length})*\n\n⏱ Топ медленных:\n${slow}`;
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
                        // КНОПКA:
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
