# Deployment (Railway)

Phase 1 runs as Railway cron services against Railway Postgres. One platform; no
always-on web service yet (deferred to Phase 3 CRM). Approx cost: ~$5-10/mo
(Hobby plan floor + idle Postgres).

## Project

- Name: `job-scanner`
- Project ID: `62f28957-2ab5-49be-8e31-2420107dfac1`
- Dashboard: https://railway.com/project/62f28957-2ab5-49be-8e31-2420107dfac1
- Environment: `production`

## Services

| Service         | Role                   | Start command                     | Cron (UTC)   |
| --------------- | ---------------------- | --------------------------------- | ------------ |
| `Postgres`      | Managed Postgres       | (managed)                         | -            |
| `edgar-ingest`  | Daily Form D ingest    | `node dist/jobs/edgar-ingest.js`  | `0 6 * * *`  |
| `weekly-digest` | Weekly outreach digest | `node dist/jobs/weekly-digest.js` | `0 13 * * 1` |

`backfill` is one-time, not a standing service. See "Backfill" below.

## Env vars (set on each cron service)

| Var              | Value                                                             |
| ---------------- | ----------------------------------------------------------------- |
| `NODE_ENV`       | `production`                                                      |
| `DATABASE_URL`   | `${{Postgres.DATABASE_URL}}` (private networking, no SSL needed)  |
| `APP_SECRET`     | generated (`openssl rand -hex 32`); required by env.ts at startup |
| `SEC_USER_AGENT` | `job-scanner ian.greenough.developer@gmail.com`                   |

Deferred (digest + alerts no-op until set): `RESEND_API_KEY`, `RESEND_FROM_EMAIL`,
`DIGEST_TO_EMAIL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Add later with
`railway variables -s weekly-digest --set "RESEND_API_KEY=..."` etc. Railway
variables are per-service; set on the service that uses them.

## Remaining dashboard steps (CLI cannot set these)

For each of `edgar-ingest` and `weekly-digest`:

1. Settings -> Source: connect GitHub repo `nullvoidundefined/job-scanner`,
   branch `main` (enables build + auto-deploy on push).
2. Settings -> Deploy -> Custom Start Command: the value from the table above.
3. Settings -> Cron Schedule: the value from the table above (UTC).

Cron services run to completion and exit; Railway does not apply the web
healthcheck to a cron deployment. `restartPolicyType = ON_FAILURE` (from
railway.toml) retries a failed run, which is safe because ingest is idempotent
(dedup on accession number).

## Migrations

Run from a workstation against the public URL (private URL only resolves inside
Railway). The secret never prints:

```bash
railway run bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npm run migrate:up'
```

## Backfill (one-time history seed)

Long-running (~30+ min: ~45 days x throttled SEC fetches). Options:

- From a workstation: `railway run bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" SEC_USER_AGENT="job-scanner ian.greenough.developer@gmail.com" node dist/jobs/backfill.js 45'` (requires `npm run build` first).
- Or temporarily set `edgar-ingest`'s start command to `node dist/jobs/backfill.js 45`, trigger one run, then restore the daily command.

## Adding the web service (Phase 3)

When the CRM UI exists, add a service from the same repo with the default
`Dockerfile` CMD (`node dist/index.js`); railway.toml already sets the `/health`
healthcheck for it.
