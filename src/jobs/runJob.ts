import { logger } from 'app/utils/logger.js';
import { sendAlert } from 'app/services/telegram.js';

// Heartbeat wrapper for cron entrypoints. A job that throws fires a Telegram
// alert and sets a non-zero exit code so the failure is visible.
export async function runJob(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  const start = Date.now();
  logger.info({ job: name }, 'job started');
  try {
    await fn();
    logger.info({ job: name, ms: Date.now() - start }, 'job finished');
  } catch (err) {
    logger.error({ job: name, err }, 'job failed');
    await sendAlert(`[job-scanner] job "${name}" failed: ${String(err)}`);
    process.exitCode = 1;
  }
}
