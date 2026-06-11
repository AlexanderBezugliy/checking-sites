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

            // 2. Стучимся в GitHub (ПРАВИЛЬНЫЙ АДРЕС: api.github.com)
            const ghResponse = await fetch('https://api.github.com/repos/AlexanderBezugliy/checking-sites/actions/workflows/monitor.yml/dispatches', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github+json',
                    'User-Agent': 'Vercel-Telegram-Bot',
                    'X-GitHub-Api-Version': '2022-11-28'
                },
                body: JSON.stringify({ ref: 'main' }) 
            });

            if (!ghResponse.ok) {
                const errText = await ghResponse.text();
                console.error('Ошибка GitHub API:', errText);
            }

        } catch (error) {
            console.error('Ошибка обработки хука:', error);
        }
    }

    return res.status(200).send('OK');
}
