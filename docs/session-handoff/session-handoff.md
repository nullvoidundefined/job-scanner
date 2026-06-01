# Session Handoff: Job Scanner

## 1. Last commit

- Branch `phase-1-form-d-radar`: `0cca0dd` feat: Railway cron and deploy config for phase 1
- Branch `main`: `4c29830` docs: phase 1-3 implementation plans
- Remote: `git@github.com:nullvoidundefined/job-scanner.git` (public).
- **The 7 new Phase 1 commits (bf29a16..0cca0dd) are NOT pushed yet** (holding push per batch-deploy preference; push when ready to deploy).

## 2. Production state

- Nothing deployed. No Railway/Vercel project yet. No CI workflow.
- Local Postgres `:5432`. Two DBs now exist: `job_scanner_test` (integration) and `job_scanner_dev` (smoke), both migrated.
- `.env` (dev smoke) and `.env.test` exist locally, both gitignored.
- 34 unit tests + 6 integration tests pass; typecheck + build clean.

## 3. What shipped this session (Phase 1 Tasks 7-13, COMPLETE)

- **Task 7** `PgRadarDB` (`src/radar/db.ts`) + `vitest.integration.config.ts` + `scripts/ensure-test-db.sh` (creates DB if missing, migrates, writes `.env.test`) + 4 Postgres integration tests.
- **Task 8** read queries (`src/radar/queries.ts`): `outreachQueue`, `rejectDistribution` + 2 integration tests.
- **Task 9** services: `telegram.sendAlert`, `email.sendDigest` (Resend); both no-op when unconfigured.
- **Task 10** `runJob` heartbeat (`src/jobs/runJob.ts`) + 2 unit tests (alerts + non-zero exit on throw).
- **Task 11** entrypoints `edgar-ingest.ts`, `backfill.ts`. **Live smoke verified**: ingested 2026-05-01 (247 seen, 11 passed, 10 companies, 27 signals).
- **Task 12** `digest.buildDigestHtml` (pure, 2 unit tests) + `weekly-digest.ts` entrypoint.
- **Task 13** `Dockerfile`, `.dockerignore`, `railway.toml` (health `/health`), README cron table + layout refresh.

**Phase 1 (Form D radar end-to-end) is functionally complete and smoke-verified.**

## 4. Pending (by urgency)

- **P1 Deploy Phase 1**: create Railway project, set env (DATABASE*URL, APP_SECRET, SEC_USER_AGENT, optional RESEND*\_/TELEGRAM\_\_), provision Postgres, push the branch, configure the 3 cron services (see README table), run `backfill 45` once. Read `production/ISSUES.md` first.
- **P2 Phase 2** (ATS, 11 tasks) and **Phase 3** (enrichment, 12 tasks) per their plans in `docs/superpowers/plans/`.
- **P2** No plan yet for spec section-10 step 3 (CRM/UI: `connection_strength` capture, contacts, pipeline). Until built, `connection_strength` is set by hand via SQL.
- **P3** Local working dir still named `ats-scanner`; only the GitHub repo is `job-scanner`. Rename when convenient.

## 5. Next session

Either **deploy Phase 1 to Railway** (P1 above) or **start Phase 2 (ATS)**.

For Phase 2, files to read first:

- `docs/superpowers/plans/2026-06-01-phase-2-*.md`
- `migrations/0001_radar_init.js` (`tracked_boards`, `job_postings` tables already exist)
- `src/radar/ingest.ts` + `src/radar/db.ts` (the orchestration + persistence pattern to mirror)

Execution mode: mechanical plan tasks (verbatim code) run inline; controller writes/commits failing tests first per R-511; integration tests need `./scripts/ensure-test-db.sh` first.
