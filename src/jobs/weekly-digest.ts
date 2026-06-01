import 'dotenv/config';
import { outreachQueue, rejectDistribution } from 'app/radar/queries.js';
import { buildDigestHtml } from 'app/radar/digest.js';
import { sendDigest } from 'app/services/email.js';
import { runJob } from 'app/jobs/runJob.js';

await runJob('weekly-digest', async () => {
  const [queue, rejects] = await Promise.all([
    outreachQueue(15),
    rejectDistribution(7),
  ]);
  await sendDigest(
    'Job Scanner: weekly outreach queue',
    buildDigestHtml(queue, rejects),
  );
});
