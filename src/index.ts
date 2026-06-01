// Load env / secrets before any app modules initialize their config.
import 'dotenv/config';
import { app } from 'app/app.js';
import { env } from 'app/config/env.js';
import { logger } from 'app/utils/logger.js';

const server = app.listen(env.PORT, '0.0.0.0', () => {
  logger.info({ port: env.PORT }, 'job-scanner listening');
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
