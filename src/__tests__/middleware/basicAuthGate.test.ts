import { basicAuthGate } from 'app/middleware/basicAuthGate.js';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

// Matches APP_SECRET set in src/__tests__/helpers/setup.ts.
const SECRET = 'test-secret';

function mockRes(): Response {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  return res;
}

function reqWith(authorization?: string): Request {
  return { headers: authorization ? { authorization } : {} } as Request;
}

function basicHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

describe('basicAuthGate', () => {
  it('calls next() when the password matches APP_SECRET', () => {
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    basicAuthGate(reqWith(basicHeader('anything', SECRET)), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a wrong password with 401 and does not call next()', () => {
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    basicAuthGate(reqWith(basicHeader('anything', 'wrong-secret')), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.set).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Basic realm="Job Scanner"',
    );
  });

  it('rejects a missing Authorization header with 401', () => {
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    basicAuthGate(reqWith(undefined), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects a malformed (non-Basic, no colon) header without throwing', () => {
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    expect(() =>
      basicAuthGate(reqWith('Bearer !!!not-base64'), res, next),
    ).not.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects a password longer than the secret without throwing', () => {
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    basicAuthGate(reqWith(basicHeader('u', `${SECRET}-extra`)), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
