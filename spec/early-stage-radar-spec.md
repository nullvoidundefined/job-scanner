# Early-Stage Radar: System Spec (Reconciled + Gap Fixes)

A personal early-stage company radar and networking CRM, built to move target companies from discovery to active interviews fast. It watches who is forming and funding in your band, attaches the people worth contacting, scores by how reachable and relevant each target is, and surfaces the right names while the moment is warm. Personal tool, one user, low volume. Keep it scrappy: the value is in working it, not in the architecture.

Kept from the velocity pass: the expanded outreach pipeline, the contacts model, network strength as the top signal, the manual search shortcut. Restored from the discovery engine: the Form D gates, the filings dedupe and reject log, the board and job-posting registries, read-time recency. Added: the evaluation strategy (section 7) and a round of gap fixes (synthetic-id keys for ATS-only companies, signal idempotency, cold-start backfill, failure alerting, reject visibility) plus four near-free signals (first-raise, intersection premium, round-grew momentum, ATS-side freshness).

## 1. Architecture

Two discovery surfaces feed one Postgres store, plus HiringCafe as a manual third surface.

```
  EDGAR daily index (Form D)        Greenhouse / Lever / Ashby public job APIs
        |                                          |
        v                                          v
  Form D client                            ATS discovery client
  (gate + score, pre-seed -> A)            (role filter, stage-agnostic, A / B+)
        \                                          /
         v                                        v
        +--------------------------------------------+
        |       COMPANIES STORE (keyed by id)        |
        |  filings  companies  signals  contacts     |
        |  tracked_boards  job_postings  touches     |
        +--------------------------------------------+
                          |
                          v
        scoring: stored warmth + recency + intersection premium at read
                          |
                          v
        outreach queue  ->  weekly digest + hot-match alert
                          |
                          v
        you work it: discovered -> researched -> contacted -> ... -> closed
```

The spine that unifies the two surfaces is `tracked_boards`, the curated universe the ATS client polls. Form D discovers unknown early companies and promotes the promising ones into it. HiringCafe finds and manual adds feed it. Form D is inbound discovery; ATS is monitoring a known list.

## 2. Data model

Defined in `0001_radar_init.sql`. The decisions that matter:

- **Companies are keyed by a synthetic `id`, not CIK.** ATS-discovered companies (the Series A and B you wanted) have no CIK, so a CIK primary key cannot represent them. `cik` is now a nullable unique column, and `domain` exists for cross-surface matching. Resolving an ATS company to a Form D company is best-effort on domain or normalized name; at this volume you tolerate the occasional duplicate rather than building real entity resolution.
- **Company creation is an upsert.** A passed Form D filing upserts a company on `cik` (create if new, refresh `latest_filing_date`, derive metro, industry, year). An ATS-discovered company upserts on `domain` or its board, with `cik` left null until it ever shows up in Form D.
- **`filings` is retained** as the immutable log, keyed on accession number for idempotent reruns, with the reject reason kept for tuning and the daily reject-distribution.
- **`signals` has `unique(company_id, type)` and is upserted.** Without it, a daily enrich run re-inserts `ai_native` every day and silently inflates the score. Recompute runs through one `recomputeWarmth(company_id)` function called after any signal or `connection_strength` change.
- **`contacts`, `tracked_boards`, `job_postings`, `connection_strength`** as before. `connection_strength` is the home for the heaviest scoring input.

## 3. Discovery and compliance

### 3.1 Form D (EDGAR)

Implemented in `edgar-ingest.ts` plus `form-d-filter.ts`. Early-catch surface, pre-seed through Series A (the $250K to $25M band covers A). The gates are the make-or-break and are intact:

1. Reject pooled investment vehicles (hedge, PE, VC funds, SPVs: the biggest noise source).
2. Reject anything outside the industry allowlist (Computers, Other Technology, Business Services).
3. Reject outside the size band.
4. Require at least one named officer or director.

Geography is a scoring signal, not a gate. The securities-type gate is dropped for recall. Without gates 1 to 3 the store fills with funds and real estate.

Because every filing is kept per CIK, two signals are free from the filings history: **first_raise** (this is the company's first ever Form D, the hottest earliest catch) and **round_grew** (a D/A amendment whose amount exceeds the prior filing, meaning the round expanded). Both are computed at ingest by looking at the company's existing filings, no new data required.

Compliance: a descriptive User-Agent with a real contact is mandatory per the SEC fair-access policy at sec.gov/os/accessing-edgar-data (the data-access rule, not the Filer Manual). Spacing is 130ms, roughly 7.7 req/s, under the 10 req/s ceiling. Parsing is null-safe throughout so a sloppy XML does not throw inside the cron.

### 3.2 ATS discovery

Stage-agnostic. Owns Series A, B, and beyond. One call per board, no auth.

| Provider   | Endpoint                                                                         |
| ---------- | -------------------------------------------------------------------------------- |
| Greenhouse | `https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`           |
| Lever      | `https://api.lever.co/v0/postings/{token}?mode=json`                             |
| Ashby      | `https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true` |

The only gate here is the role filter (senior, staff, founding, or lead engineering titles, remote or in a target metro). Each pull upserts into `job_postings` keyed on `{provider}:{nativeId}`: new ids are freshly posted, seen ids get `last_seen_at` bumped, vanished ids get `closed_at` set. The pull also refreshes `companies.latest_fresh_role_date` to the newest non-stale matching role, which is the ATS-side freshness clock.

- **Ghost-listing mitigation.** A posting not bumped in 90 days is treated as stale and stops counting toward `hiring_eng` and freshness, even if still on the board.
- **Board-health automation.** Three consecutive daily 404s flip `is_active = false` and fire a Telegram alert. `tracked_boards.consecutive_failures` tracks the streak.

### 3.3 HiringCafe (manual)

Browse it, and when you find a company worth tracking, add its board to `tracked_boards`. At 50 to 100 companies this is an afternoon.

## 4. Scoring

Stored warmth, plus recency and the intersection premium added at read. `companies.warmth_score` holds the sum of stable and enrichment signals (network, hiring_eng, ai_native, stage, metro, yc, first_raise, round_grew) and is recomputed by `recomputeWarmth` whenever those change. Recency and the conjunction bonus are computed live in the digest query so they decay correctly without a nightly rewrite.

| Signal                                  | Weight     | Stored        | When                  |
| --------------------------------------- | ---------- | ------------- | --------------------- |
| connection_strength = direct            | 20         | companies col | set at research       |
| connection_strength = recruiter         | 12         | companies col | set at research       |
| hiring_eng                              | 10         | signals       | enrichment (ATS join) |
| ai_native = yes                         | 8          | signals       | enrichment (Haiku)    |
| recency <= 7 / <= 30 / <= 45 days       | 10 / 6 / 3 | computed      | read time             |
| first_raise                             | 6          | signals       | Form D history        |
| seed round                              | 5          | signals       | Form D                |
| round_grew                              | 3          | signals       | Form D history        |
| series_a                                | 3          | signals       | Form D                |
| target_metro                            | 3          | signals       | sync                  |
| yc_batch                                | 3          | signals       | enrichment            |
| young_company                           | 2          | signals       | sync                  |
| intersection premium (fresh AND hiring) | +5         | computed      | read time             |

Network leverage is the heaviest input by design. The **intersection premium** captures the original edge: a company that is freshly funded AND hiring engineers is worth more than the sum of those two signals, because that pair is the actual sweet spot. Recency takes the more recent of the Form D and ATS clocks, so ATS-only companies still get a freshness boost from a newly posted role.

```sql
-- Outreach queue: stored warmth + read-time recency (filing OR fresh role) + intersection premium.
select c.*,
       c.warmth_score
       + r.recency_bonus
       + case when r.recency_bonus > 0
               and exists (select 1 from signals s
                           where s.company_id = c.id and s.type = 'hiring_eng')
              then 5 else 0 end as live_score
from companies c
cross join lateral (
  select case
    when greatest(c.latest_filing_date, c.latest_fresh_role_date) >= current_date - 7  then 10
    when greatest(c.latest_filing_date, c.latest_fresh_role_date) >= current_date - 30 then 6
    when greatest(c.latest_filing_date, c.latest_fresh_role_date) >= current_date - 45 then 3
    else 0 end as recency_bonus
) r
where c.status in ('discovered', 'researched')
order by live_score desc
limit 15;
```

## 5. Pipeline and contact discovery

`discovered` (automated, ingested at high warmth) to `researched` (contact identified, profiles linked, context logged) to `contacted` to `responded` to `interviewing` to `rejected` or `closed`.

No automated contact scraping or email guessing. It is fragile and risks your own accounts. The `discovered -> researched` transition is a human-in-the-loop step with a 30-second macro: a high-priority item exposes a one-click search,

```
https://www.google.com/search?q=site:linkedin.com/in/+"[Company Name]"+(Founder|CTO|"VP of Engineering")
```

You copy the contact into the form, which writes a `contacts` row and bumps the company to `researched`.

## 6. Phase 2: enrichment

Layered in after the phase 1 loop is stable, on gate-passers only.

- **Model.** Haiku (current Haiku 4.5) for the yes / maybe / no AI-native tag. Cost-appropriate for a near-binary classification; Sonnet, and certainly the dated 3.5 Sonnet, is overkill.
- **Cost lever is the Batch API, not prompt caching.** The nightly run has no latency requirement, so batch (about half cost) is the saving. Caching does not help: the classification prompt is small, likely under the minimum cacheable prefix (1,024 tokens, 2,048 for 3.5 Haiku), only discounts the cached prefix's reads, and the dynamic input is never cacheable.
- **Classification.** `{"tag":"yes"|"maybe"|"no","reason":"<= 12 words"}`. "yes" means AI or ML is the core product, "maybe" applied to a vertical, "no" incidental.
- **Trust but verify.** `COALESCE(ai_native_override_tag, ai_native_tag)` when emitting the signal; your correction wins.

## 7. Evaluation and testing

An eval harness removes the iteration cost of tuning (re-running is instant once it exists), not the judgment cost of deciding what correct means, which it relocates to building the labeled set. An eval is only as good as its oracle.

- **AI-native classifier: a real eval, highest value.** Labeled set of company to expected tag, run the Haiku classifier, measure accuracy, iterate the prompt against disagreements. Cheap over Batch.
- **Parser and ATS normalizers: fixture suites.** Roughly 20 real filings and board responses spanning the ugly cases (no middle name, multiple related persons, "Indefinite" amount, yetToBeFormed, pooled fund, debt-only, board 404s) with asserted output. The reject log is where you find the cases.
- **Filter gates: labeled gold set.** Label 100 to 200 real filings pass/reject from `filings.reject_reason`, run the filter, read precision and recall, study the false positives. The labeling is the irreducible judgment.
- **Warmth weights: no build-time eval.** The real eval is the post-deployment outcome (do high-warmth companies convert toward interviews). Eyeballing the queue is enough at build time.

Labels and fixtures live in the repo, not the schema.

## 8. Orchestration

Railway cron. Every job dedupes on a stable key, so reruns are safe.

| Job           | Cadence     | Action                                                                                                             |
| ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| backfill      | one-time    | loop `edgar-ingest` over the last 30 to 60 days and seed `tracked_boards`, so day one has a populated queue        |
| edgar-ingest  | daily 06:00 | ingest yesterday's Form D, gate, score, upsert companies and signals                                               |
| ats-pull      | daily 07:00 | poll active boards, upsert `job_postings`, set `matches_role`, refresh `latest_fresh_role_date`, board-health      |
| enrich        | daily 08:00 | new gate-passers: ai_native (Haiku, batch), yc_batch; recomputeWarmth                                              |
| weekly-digest | Mon 13:00   | email the top of the queue by live score, plus a one-line reject-reason distribution for the week                  |
| heartbeat     | each job    | a job that throws, or fails to run, fires a Telegram alert; an unattended cron that dies silently is the real risk |
| hot-alert     | hourly      | push companies crossing the hot threshold, once each                                                               |

Two operational fixes folded in here: the **backfill** so the tool is useful on day one rather than after a month of accumulation, and the **heartbeat** dead-man's-switch so a dead cron does not go unnoticed for weeks. The weekly digest carries the reject distribution so you tune the gates from the email instead of hand-querying.

## 9. Failure modes and honest limits

- **Cross-surface duplicates.** Best-effort matching on domain or name means a company occasionally lands twice (once from Form D, once from ATS). Acceptable at this volume; merge by hand when you notice.
- **Form D recall gaps.** SAFE rounds file late or thin; named persons can be counsel. High precision, incomplete recall. Cover with Product Hunt and YC.
- **Industry taxonomy is coarse.** The `ai_native` tag, not the industry gate, does the real sorting.
- **Offering amount is unreliable.** The band is a sieve, not a stage classifier.
- **Board-token maintenance.** Board-health catches the obvious breaks; the rest is manual tending.
- **The network signal needs feeding.** It is the heaviest input and entirely manual. Set `connection_strength` or the model defaults to metadata-only ranking.
- **The procrastination trap.** The tool only pays off if you send the messages.

## 10. Build sequence

1. **Form D half, end to end, with gates and backfill.** Run the migration, wire the data layer, schedule `edgar-ingest`, backfill the last 30 to 60 days, email the outreach-queue query plus the reject distribution, and wire the heartbeat alert. Build the parser fixture suite while debugging the XML mapping and seed the filter's labeled set from the reject log. first_raise and round_grew come for free here. Working radar by the end. Use it a week.
2. **ATS discovery.** `tracked_boards`, `job_postings`, the three pullers (each with a normalizer fixture test), the role filter, the `hiring_eng` join, `latest_fresh_role_date`, ghost-listing and board-health. Brings in Series A and B.
3. **Scoring and CRM.** Full warmth weights including the intersection premium, `connection_strength` capture in the research step, the expanded pipeline, the search macro.
4. **Enrichment and alerts.** Haiku AI-native tagging via Batch behind a classifier eval, YC cross-ref, the weekly digest with drafted angles, the hot-match push.

Phase 1 is the MVP and the only phase that must exist for the tool to be useful. Everything after is enhancement.
