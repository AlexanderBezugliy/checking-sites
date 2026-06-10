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

    if (failures.length > 0 && BOT_TOKEN && CHAT_ID) {
        const message = `⚠️ *Проблемы со статусом сайтов (${failures.length}/${sites.length}):*\n\n${failures.join("\n")}`;

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
                    }),
                },
            );
            console.log("Алерт отправлен в Telegram");
        } catch (tgError) {
            console.error("Ошибка отправки в TG:", tgError);
        }
    } else {
        console.log(
            "Все важные сайты работают (или отдают ожидаемый 503). В ТГ пусто.",
        );
    }
}

runMonitor();
