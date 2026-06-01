# Job Scanner

A personal early-stage company radar and networking CRM. It watches who is
forming and funding in a target band, attaches the people worth contacting,
scores by how reachable and relevant each target is, and surfaces the right
names while the moment is warm. Single user, low volume.

Full design in [`spec/early-stage-radar-spec.md`](spec/early-stage-radar-spec.md).

## How it works

Two discovery surfaces feed one Postgres store:

- **Form D (EDGAR)**: daily index of new securities filings, gated to pre-seed
  through Series A in a tech/business-services band.
- **ATS job boards**: Greenhouse / Lever / Ashby public APIs, monitoring a
  curated list of companies for senior engineering roles.

A scoring layer ranks targets by network strength, recency, and a
freshly-funded-AND-hiring intersection premium. Cron jobs ingest daily and a
weekly digest surfaces the top of the outreach queue.

## Stack

- Express 5 + TypeScript (single service)
- PostgreSQL (raw SQL via `pg`, node-pg-migrate for migrations)
- Anthropic Claude (Haiku) for AI-native classification (Phase 2)
- Railway cron for orchestration; Resend for the digest; Telegram for alerts
- Single-secret HTTP Basic gate (one user; the CRM holds contact PII)

## Development

```bash
npm install
cp .env.example .env   # then fill in DATABASE_URL, APP_SECRET, SEC_USER_AGENT
npm run migrate:up     # requires DATABASE_URL in the environment
npm run dev            # server on PORT (default 3001)
npm test
```

## Scripts

| Script                                | Purpose                              |
| ------------------------------------- | ------------------------------------ |
| `npm run dev`                         | Watch-mode server (tsx)              |
| `npm run build`                       | Compile to `dist/` (tsc + tsc-alias) |
| `npm start`                           | Run the compiled server              |
| `npm run typecheck`                   | Type-check without emitting          |
| `npm test`                            | Run unit tests (Vitest)              |
| `npm run migrate:up` / `migrate:down` | Apply / roll back migrations         |
| `npm run format`                      | Format with Prettier                 |

## Build sequence

Per the spec, Phase 1 (Form D end-to-end with gates, backfill, digest,
heartbeat) is the MVP and the only phase that must exist for the tool to be
useful. ATS discovery, full scoring/CRM, and enrichment follow.

## Project layout

```
src/
  config/env.ts        Zod-validated environment
  db/pool.ts           Postgres pool + query/transaction helpers
  utils/logger.ts      Pino logger
  middleware/          basicAuthGate, errorHandler
  app.ts               Express app (health probes + gate)
  index.ts             Server bootstrap
migrations/            node-pg-migrate (0001 = radar schema)
spec/                  Design spec + reference implementations
```
