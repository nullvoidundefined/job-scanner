import { logger } from 'app/utils/logger.js';
import type { NextFunction, Request, Response } from 'express';

// Final error handler. Logs the error server-side and returns a generic 500 so
// no internals leak to the client.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  logger.error({ err }, 'unhandled error');
  if (res.headersSent) return;
  res.status(500).json({ error: { message: 'Internal server error' } });
}
