import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'staging', 'test'])
    .default('development'),
  PORT: z.coerce.number().default(3001),

  // Database. Provide DATABASE_CA_CERT for verified SSL (e.g. Neon, RDS).
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_CA_CERT: z.string().optional(),

  // Single-secret gate guarding the CRM (it holds contact PII).
  // Generate with: openssl rand -hex 32
  APP_SECRET: z.string().min(1, 'APP_SECRET is required'),

  // EDGAR fair-access: a descriptive User-Agent with a real contact is
  // mandatory under the SEC data-access policy. Example: "job-scanner you@x.com"
  SEC_USER_AGENT: z.string().min(1, 'SEC_USER_AGENT is required'),

  // Weekly digest email (Resend). Optional until the digest job is wired.
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().default('radar@example.com'),
  DIGEST_TO_EMAIL: z.string().optional(),

  // AI-native enrichment (Phase 2, Anthropic Haiku). Optional.
  ANTHROPIC_API_KEY: z.string().optional(),
});

const parsed = envSchema.parse(process.env);

export const env = Object.freeze(parsed);
export const isDev = env.NODE_ENV === 'development';
export const isProd = env.NODE_ENV === 'production';
