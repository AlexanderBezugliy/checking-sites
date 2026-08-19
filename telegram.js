const TG_LIMIT = 4000;

function splitTelegramText(text, limit = TG_LIMIT) {
    if (!text) return [""];
    if (text.length <= limit) return [text];

    const parts = [];
    const lines = text.split("\n");
    let current = "";

    for (const line of lines) {
        if (line.length > limit) {
            if (current) {
                parts.push(current);
                current = "";
            }
            for (let i = 0; i < line.length; i += limit) {
                parts.push(line.slice(i, i + limit));
            }
            continue;
        }

        const next = current ? `${current}\n${line}` : line;
        if (next.length > limit) {
            parts.push(current);
            current = line;
        } else {
            current = next;
        }
    }

    if (current) parts.push(current);
    return parts;
}

async function sendTelegram({ token, chatId, text, replyMarkup }) {
    const parts = splitTelegramText(text);

    for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        const body = {
            chat_id: chatId,
            text: parts[i],
            parse_mode: "Markdown",
        };
        if (isLast && replyMarkup) {
            body.reply_markup = replyMarkup;
        }

        const res = await fetch(
            `https://api.telegram.org/bot${token}/sendMessage`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            },
        );

        if (!res.ok) {
            console.error("Ошибка Telegram:", await res.text());
        }

        if (!isLast) {
            await new Promise((resolve) => setTimeout(resolve, 400));
        }
    }
}

module.exports = { sendTelegram, splitTelegramText, TG_LIMIT };
