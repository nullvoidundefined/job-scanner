import { env } from 'app/config/env.js';
import { logger } from 'app/utils/logger.js';

// Fire-and-log alert. No-op (with a warning) when Telegram is not configured.
export async function sendAlert(text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    logger.warn({ text }, 'telegram not configured; alert dropped');
    return;
  }
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
  } catch (err) {
    logger.error({ err }, 'telegram send failed');
  }
}
