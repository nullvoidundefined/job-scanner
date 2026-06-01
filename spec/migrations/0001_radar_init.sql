-- 0001_radar_init.sql  (reconciled + gap fixes)
-- Early-stage radar: Form D + ATS discovery feeding a networking CRM.
--
-- Key change from the prior version: companies are keyed by a synthetic id, not CIK,
-- because ATS-discovered companies (Series A/B found via their board) have no CIK.
-- cik is a nullable unique column; domain supports best-effort cross-surface matching.

-- Deduped company, keyed by a synthetic id so ATS-only companies are first-class.
create table companies (
  id                     bigint generated always as identity primary key,
  cik                    text unique,                     -- null for ATS-only companies
  domain                 text,                            -- for cross-surface entity matching
  name                   text not null,
  website                text,
  ats_board_url          text,
  entity_type            text,
  year_of_inc            int,
  hq_city                text,
  hq_state               text,
  in_target_metro        boolean not null default false,  -- signal, not a gate
  industry_group         text,

  -- Network leverage: the heaviest scoring input. Set by hand during research.
  connection_strength    text not null default 'none',    -- none | recruiter | direct

  -- AI-native classification (Phase 2). The override wins via COALESCE in scoring.
  ai_native_tag          text,                             -- 'yes' | 'maybe' | 'no'
  ai_native_override_tag text,
  ai_native_reason       text,

  -- Stable + enrichment signals only. Recency and the intersection premium are added
  -- at read time, never stored here. Recompute via recomputeWarmth(company_id).
  warmth_score           numeric not null default 0,
  status                 text not null default 'discovered',
    -- discovered | researched | contacted | responded | interviewing | rejected | closed

  -- Two freshness clocks; the digest takes the more recent of the two at read time.
  latest_filing_date     date,                             -- Form D side
  latest_fresh_role_date date,                             -- ATS side: newest non-stale matching role

  first_seen_at          timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index on companies (cik);
create index on companies (domain);
create index on companies (status);
create index idx_companies_warmth on companies (warmth_score desc)
  where status in ('discovered', 'researched');

-- Immutable Form D event log. Accession is the dedupe key (idempotent reruns).
-- Rejects are kept, with reason, so the gate thresholds stay tunable and the daily
-- digest can report a reject-reason distribution.
create table filings (
  accession_number      text primary key,
  company_id            bigint references companies(id) on delete cascade,
  cik                   text not null,                  -- used to upsert/match the company
  form_type             text not null,                  -- 'D' | 'D/A'
  is_amendment          boolean not null default false,
  filing_date           date not null,
  date_of_first_sale    date,
  industry_group        text,
  is_pooled_fund        boolean not null default false,
  securities_types      text[] not null default '{}',
  total_offering_amount numeric,
  total_amount_sold     numeric,
  raw_url               text not null,
  filter_verdict        text not null,                  -- 'passed' | 'rejected'
  reject_reason         text,
  fetched_at            timestamptz not null default now()
);
create index on filings (company_id);
create index on filings (cik);                            -- "is this the first filing for this CIK"
create index on filings (filing_date desc);
create index on filings (filter_verdict);

-- Append-only-ish enrichment signals. UNIQUE(company_id, type) so a re-run upserts
-- instead of inserting duplicates that would silently inflate warmth_score.
create table signals (
  id          bigint generated always as identity primary key,
  company_id  bigint not null references companies(id) on delete cascade,
  type        text not null,
    -- hiring_eng | ai_native | yc_batch | target_metro | seed | series_a
    -- | young_company | first_raise | round_grew
  weight      numeric not null default 1,
  source      text,            -- form_d | greenhouse | lever | ashby | manual
  detected_at timestamptz not null default now(),
  unique (company_id, type)
);
create index on signals (company_id);

-- Outreach targets.
create table contacts (
  id             bigint generated always as identity primary key,
  company_id     bigint not null references companies(id) on delete cascade,
  full_name      text not null,
  role           text,          -- 'Founder' | 'CTO' | 'VP Eng' | 'Head of Product'
  linkedin_url   text,
  email          text,
  twitter_handle text,
  is_primary     boolean not null default false
);
create index on contacts (company_id);

-- Curated boards the ATS puller monitors. Backs board-health automation.
create table tracked_boards (
  provider             text not null,        -- 'greenhouse' | 'lever' | 'ashby'
  token                text not null,
  company_id           bigint references companies(id) on delete cascade,
  added_via            text,                 -- 'form_d' | 'hiringcafe' | 'manual'
  is_active            boolean not null default true,
  consecutive_failures int not null default 0, -- 3 in a row -> deactivate and alert
  last_pulled_at       timestamptz,
  primary key (provider, token)
);

-- Roles found via the ATS surface. last_seen_at drives ghost-listing staleness:
-- a role not bumped in 90 days stops counting toward hiring_eng and freshness.
create table job_postings (
  id            text primary key,      -- '{provider}:{nativeId}'
  company_id    bigint references companies(id) on delete cascade,
  provider      text not null,
  title         text not null,
  location      text,
  is_remote     boolean,
  url           text not null,
  matches_role  boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  closed_at     timestamptz
);
create index on job_postings (company_id);
create index on job_postings (last_seen_at desc);

-- Append-only interaction history.
create table touches (
  id          bigint generated always as identity primary key,
  company_id  bigint not null references companies(id) on delete cascade,
  contact_id  bigint references contacts(id) on delete set null,
  channel     text,            -- linkedin | email | warm_intro | twitter
  note        text,
  occurred_at timestamptz not null default now()
);
create index on touches (company_id);
