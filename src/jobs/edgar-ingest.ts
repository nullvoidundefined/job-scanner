import 'dotenv/config';
import { logger } from 'app/utils/logger.js';
import { ingestDay } from 'app/radar/ingest.js';
import { PgRadarDB } from 'app/radar/db.js';
import { runJob } from 'app/jobs/runJob.js';

function yesterdayIso(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

await runJob('edgar-ingest', async () => {
  const date = process.argv[2] ?? yesterdayIso();
  const result = await ingestDay(date, new PgRadarDB());
  logger.info({ date, ...result }, 'ingest complete');
});
