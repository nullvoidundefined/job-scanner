import { timingSafeEqual } from 'node:crypto';
import { env } from 'app/config/env.js';
import type { NextFunction, Request, Response } from 'express';

// Single-secret HTTP Basic gate. One user, so the username is ignored and the
// password is compared against APP_SECRET in constant time. Mount AFTER the
// health probes so liveness/readiness stay unauthenticated.
export function basicAuthGate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization ?? '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (isSecretMatch(password, env.APP_SECRET)) {
      next();
      return;
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Job Scanner"');
  res.status(401).json({ error: { message: 'Unauthorized' } });
}

// Length-checked constant-time comparison. timingSafeEqual throws on unequal
// lengths, so guard first (the length check itself is not secret-dependent).
function isSecretMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
