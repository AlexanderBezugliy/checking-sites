const fs = require('fs');

async function runMonitor() {
  const sites = JSON.parse(fs.readFileSync('./sites.json', 'utf8'));
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  const results = [];
  const failures = [];
  const BATCH_SIZE = 25; // Проверяем пачками по 25 штук асинхронно
  
  for (let i = 0; i < sites.length; i += BATCH_SIZE) {
    const batch = sites.slice(i, i + BATCH_SIZE);
    
    const promises = batch.map(async (site) => {
      const startTime = Date.now();
      try {
        const response = await fetch(site.url, { 
          method: 'GET', 
          signal: AbortSignal.timeout(10000) // Таймаут 10 секунд
        });
        
        const duration = Date.now() - startTime;
        results.push({ url: site.url, status: response.status, ok: response.ok, duration });
        
        if (!response.ok) {
          failures.push(`❌ *${site.url}* — HTTP ${response.status}`);
        }
      } catch (error) {
        results.push({ url: site.url, status: 'ERROR', ok: false, error: error.message });
        failures.push(`🚨 *${site.url}* — Ошибка: ${error.message}`);
      }
    });

    await Promise.allSettled(promises);
  }

  // Сохраняем слепок статусов
  const statusData = {
    last_update: new Date().toISOString(),
    total_sites: sites.length,
    failed_count: failures.length,
    data: results
  };
  fs.writeFileSync('./status.json', JSON.stringify(statusData, null, 2));

  // Шлем алерт в Telegram, если есть упавшие сайты
  if (failures.length > 0 && BOT_TOKEN && CHAT_ID) {
    const message = `⚠️ *Проблемы со статусом сайтов (${failures.length}/${sites.length}):*\n\n${failures.join('\n')}`;
    
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'Markdown' })
      });
      console.log('Алерт отправлен в Telegram');
    } catch (tgError) {
      console.error('Ошибка отправки в TG:', tgError);
    }
  } else {
    console.log('Все сайты работают штатно. Спамить в ТГ не нужно.');
  }
}

runMonitor();