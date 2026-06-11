import https from 'https';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { callback_query } = req.body;

    if (callback_query && callback_query.data === 'check_now') {
        const callbackQueryId = callback_query.id;

        try {
            // 1. Отвечаем Телеграму
            await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    callback_query_id: callbackQueryId,
                    text: '⏳ Сигнал принят. Запускаю проверку в GitHub...',
                    show_alert: false 
                })
            });

            // 2. Стучимся в GitHub через IPv4
            const postData = JSON.stringify({ ref: 'main' }); 

            const options = {
                hostname: 'api.github.org',
                port: 443,
                path: '/repos/AlexanderBezugliy/checking-sites/actions/workflows/monitor.yml/dispatches',
                method: 'POST',
                family: 4, // <-- ЖЕСТКО ФОРСИРУЕМ IPV4. ЭТО УБЕРЕТ БАГ С ENOTFOUND
                headers: {
                    'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github+json',
                    'User-Agent': 'Vercel-Telegram-Bot',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            await new Promise((resolve, reject) => {
                const request = https.request(options, (response) => {
                    if (response.statusCode >= 200 && response.statusCode < 300) {
                        resolve(response);
                    } else {
                        reject(new Error(`GitHub API ответил статусом: ${response.statusCode}`));
                    }
                });

                request.on('error', (e) => {
                    console.error('Ошибка классического запроса к GitHub:', e);
                    reject(e);
                });

                request.write(postData);
                request.end();
            });

        } catch (error) {
            console.error('Ошибка обработки хука:', error);
        }
    }

    return res.status(200).send('OK');
}
