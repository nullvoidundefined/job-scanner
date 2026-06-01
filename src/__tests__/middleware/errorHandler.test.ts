import { errorHandler } from 'app/middleware/errorHandler.js';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

function mockRes(headersSent: boolean): Response {
  const res = {} as Response;
  res.headersSent = headersSent;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('errorHandler', () => {
  it('responds 500 with a generic message', () => {
    const res = mockRes(false);

    errorHandler(
      new Error('boom'),
      {} as Request,
      res,
      vi.fn() as NextFunction,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { message: 'Internal server error' },
    });
  });

  it('does nothing when headers were already sent', () => {
    const res = mockRes(true);

    errorHandler(
      new Error('boom'),
      {} as Request,
      res,
      vi.fn() as NextFunction,
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
