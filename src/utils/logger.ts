import { env } from 'app/config/env.js';
import pino from 'pino';

const isProd = env.NODE_ENV === 'production';

export const logger = pino({
  level: isProd ? 'info' : 'debug',
  // base structured JSON logs in all environments
  ...(isProd
    ? {}
    : {
        // pretty-print only in development
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }),
});
