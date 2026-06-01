// Global test setup: provide required env vars so Zod validation in env.ts
// passes at import time. Integration tests that need a real database set
// DATABASE_URL in their own beforeAll.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb';
process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret';
process.env.SEC_USER_AGENT =
  process.env.SEC_USER_AGENT || 'job-scanner test@example.com';
