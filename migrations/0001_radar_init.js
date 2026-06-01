// 0001_radar_init: Form D + ATS discovery feeding a networking CRM.
// Companies are keyed by a synthetic id (not CIK), because ATS-discovered
// companies have no CIK. cik is a nullable unique column; domain supports
// best-effort cross-surface matching.
//
// The schema is run as raw SQL (authored and reviewed in the spec) rather than
// the node-pg-migrate builder API, to keep it identical to the spec.

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.sql(`
    create table companies (
      id                     bigint generated always as identity primary key,
      cik                    text unique,
      domain                 text,
      name                   text not null,
      website                text,
      ats_board_url          text,
      entity_type            text,
      year_of_inc            int,
      hq_city                text,
      hq_state               text,
      in_target_metro        boolean not null default false,
      industry_group         text,
      connection_strength    text not null default 'none',
      ai_native_tag          text,
      ai_native_override_tag text,
      ai_native_reason       text,
      warmth_score           numeric not null default 0,
      status                 text not null default 'discovered',
      latest_filing_date     date,
      latest_fresh_role_date date,
      first_seen_at          timestamptz not null default now(),
      updated_at             timestamptz not null default now()
    );
    create index on companies (cik);
    create index on companies (domain);
    create index on companies (status);
    create index idx_companies_warmth on companies (warmth_score desc)
      where status in ('discovered', 'researched');

    create table filings (
      accession_number      text primary key,
      company_id            bigint references companies(id) on delete cascade,
      cik                   text not null,
      form_type             text not null,
      is_amendment          boolean not null default false,
      filing_date           date not null,
      date_of_first_sale    date,
      industry_group        text,
      is_pooled_fund        boolean not null default false,
      securities_types      text[] not null default '{}',
      total_offering_amount numeric,
      total_amount_sold     numeric,
      raw_url               text not null,
      filter_verdict        text not null,
      reject_reason         text,
      fetched_at            timestamptz not null default now()
    );
    create index on filings (company_id);
    create index on filings (cik);
    create index on filings (filing_date desc);
    create index on filings (filter_verdict);

    create table signals (
      id          bigint generated always as identity primary key,
      company_id  bigint not null references companies(id) on delete cascade,
      type        text not null,
      weight      numeric not null default 1,
      source      text,
      detected_at timestamptz not null default now(),
      unique (company_id, type)
    );
    create index on signals (company_id);

    create table contacts (
      id             bigint generated always as identity primary key,
      company_id     bigint not null references companies(id) on delete cascade,
      full_name      text not null,
      role           text,
      linkedin_url   text,
      email          text,
      twitter_handle text,
      is_primary     boolean not null default false
    );
    create index on contacts (company_id);

    create table tracked_boards (
      provider             text not null,
      token                text not null,
      company_id           bigint references companies(id) on delete cascade,
      added_via            text,
      is_active            boolean not null default true,
      consecutive_failures int not null default 0,
      last_pulled_at       timestamptz,
      primary key (provider, token)
    );

    create table job_postings (
      id            text primary key,
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

    create table touches (
      id          bigint generated always as identity primary key,
      company_id  bigint not null references companies(id) on delete cascade,
      contact_id  bigint references contacts(id) on delete set null,
      channel     text,
      note        text,
      occurred_at timestamptz not null default now()
    );
    create index on touches (company_id);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.sql(`
    drop table if exists touches, job_postings, tracked_boards, contacts,
      signals, filings, companies cascade;
  `);
};
