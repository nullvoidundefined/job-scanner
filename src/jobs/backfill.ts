import 'dotenv/config';
import { logger } from 'app/utils/logger.js';
import { ingestDay } from 'app/radar/ingest.js';
import { PgRadarDB } from 'app/radar/db.js';
import { runJob } from 'app/jobs/runJob.js';

// Usage: node dist/jobs/backfill.js [days=45]
await runJob('backfill', async () => {
  const days = Number(process.argv[2] ?? 45);
  const db = new PgRadarDB();
  let totalPassed = 0;
  for (let i = days; i >= 1; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const result = await ingestDay(date, db);
    totalPassed += result.passed;
    logger.info({ date, ...result }, 'backfill day complete');
  }
  logger.info({ days, totalPassed }, 'backfill complete');
});
