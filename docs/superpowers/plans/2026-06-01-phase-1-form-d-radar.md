# Phase 1: Form D Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Form D half of the radar end to end: ingest yesterday's EDGAR Form D filings, gate and score them, persist through the id-keyed model, and surface the outreach queue as a weekly digest, with a heartbeat dead-man's-switch.

**Architecture:** Pure logic (XML parse, gates, scoring) is separated from IO (HTTP client, Postgres). The `RadarDB` interface is the seam between orchestration and persistence: `ingestDay` is unit-tested against an in-memory fake, and the real `PgRadarDB` is integration-tested against a live Postgres. Cron entrypoints are plain Node scripts wrapped in a heartbeat that alerts on failure.

**Tech Stack:** Express 5, TypeScript (NodeNext ESM), Postgres via `pg`, `fast-xml-parser`, `node-pg-migrate`, Resend (digest email), Telegram (alerts), Vitest.

**Conventions (apply to every task):**

- No em dash (U+2014) anywhere, including comments and test fixtures. Rule R-001.
- Prettier: 2-space, 80-width, single-quote, trailing commas. Imports use the `app/*` alias and `.js` extensions (NodeNext), e.g. `import { query } from 'app/db/pool.js'`.
- Pure modules (`parse.ts`, `form-d-filter.ts`, `scoring.ts`) must NOT import `app/config/env.js`, so their tests need no env.
- Commit after each task. Pre-commit formats staged files; pre-push runs typecheck + test + build.

---

## File Structure

```
src/radar/
  config.ts          Tuning constants (gates, weights, metros, role regex). Pure.
  parse.ts           parseDailyIndex + parseFormDXml. Pure (fast-xml-parser only).
  form-d-filter.ts   evaluate(): gate-then-score. Pure. Owns ParsedFormD type.
  scoring.ts         warmthFromSignals + LIVE_SCORE_SQL. Pure.
  edgar-client.ts    secFetch, listFormDFilings, fetchAndParse. IO (reads env).
  ingest.ts          RadarDB interface + ingestDay orchestration.
  db.ts              PgRadarDB: RadarDB backed by app/db/pool.
  queries.ts         outreachQueue(), rejectDistribution() read queries.
src/services/
  telegram.ts        sendAlert(text): Telegram Bot API, no-op if unconfigured.
  email.ts           sendDigest(html): Resend, no-op if unconfigured.
src/jobs/
  runJob.ts          Heartbeat wrapper: run fn, alert on throw, set exit code.
  edgar-ingest.ts    Entrypoint: ingest yesterday.
  backfill.ts        Entrypoint: ingest a date range (one-time seed).
  weekly-digest.ts   Entrypoint: build + send the digest email.
src/__tests__/
  fixtures/form-d/   Captured primary_doc.xml + master.idx samples.
  radar/*.test.ts    Unit tests.
  integration/radar-db.test.ts  PgRadarDB against real Postgres.
```

---

## Task 1: Port tuning config

**Files:**

- Create: `src/radar/config.ts`

The spec's reference config lives at `spec/src/config.ts`. Port it with one change: remove `USER_AGENT` (moves to env as `SEC_USER_AGENT`); keep `MIN_REQUEST_SPACING_MS` (a pure constant).

- [ ] **Step 1: Create the config**

Copy `spec/src/config.ts` verbatim into `src/radar/config.ts`, then delete the `USER_AGENT` export. Keep everything else (SIZE*BAND, INDUSTRY_ALLOWLIST, SIGNAL_WEIGHTS, CONNECTION_WEIGHTS, RECENCY_TIERS, INTERSECTION_BONUS, TARGET_METROS, ROLE*\* regex, MIN_REQUEST_SPACING_MS). Reindent to 2-space.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no importers yet).

- [ ] **Step 3: Commit**

```bash
git add src/radar/config.ts
git commit -m "feat: port radar tuning config"
```

---

## Task 2: Form D filter (gates + sync signals), test-first

**Files:**

- Create: `src/radar/form-d-filter.ts`
- Test: `src/__tests__/radar/form-d-filter.test.ts`

The reference implementation is `spec/src/form-d-filter.ts` (pure, already written). Fix its import to `from 'app/radar/config.js'`. Write the tests first to lock behavior, then port.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/radar/form-d-filter.test.ts
import { evaluate } from 'app/radar/form-d-filter.js';
import type { ParsedFormD } from 'app/radar/form-d-filter.js';
import { describe, expect, it } from 'vitest';

function filing(overrides: Partial<ParsedFormD> = {}): ParsedFormD {
  return {
    accessionNumber: '0001-23-456789',
    cik: '1234567',
    formType: 'D',
    isAmendment: false,
    filingDate: '2026-05-01',
    dateOfFirstSale: null,
    industryGroupType: 'Computers',
    isPooledFund: false,
    securitiesTypes: ['Equity'],
    totalOfferingAmount: 2_000_000,
    totalAmountSold: 500_000,
    issuer: {
      name: 'Acme AI',
      entityType: 'Corporation',
      yearOfInc: 2025,
      city: 'San Francisco',
      state: 'CA',
      zip: '94107',
    },
    relatedPersons: [
      { fullName: 'Jane Doe', relationships: ['Executive Officer'] },
    ],
    ...overrides,
  };
}

describe('evaluate gates', () => {
  it('passes a clean in-band tech filing with a named officer', () => {
    const r = evaluate(filing());
    expect(r.verdict).toBe('passed');
  });

  it('rejects a pooled investment fund', () => {
    const r = evaluate(filing({ isPooledFund: true }));
    expect(r.verdict).toBe('rejected');
    expect(r.rejectReason).toBe('pooled investment fund');
  });

  it('rejects an industry outside the allowlist', () => {
    const r = evaluate(filing({ industryGroupType: 'Real Estate' }));
    expect(r.verdict).toBe('rejected');
    expect(r.rejectReason).toContain('industry not in allowlist');
  });

  it('rejects an indefinite offering amount', () => {
    const r = evaluate(filing({ totalOfferingAmount: 'indefinite' }));
    expect(r.verdict).toBe('rejected');
  });

  it('rejects an amount below the band', () => {
    const r = evaluate(filing({ totalOfferingAmount: 100_000 }));
    expect(r.verdict).toBe('rejected');
    expect(r.rejectReason).toContain('out of band');
  });

  it('rejects an amount above the band', () => {
    const r = evaluate(filing({ totalOfferingAmount: 50_000_000 }));
    expect(r.verdict).toBe('rejected');
  });

  it('rejects when no officer or director is named', () => {
    const r = evaluate(
      filing({
        relatedPersons: [
          { fullName: 'Pat Counsel', relationships: ['Promoter'] },
        ],
      }),
    );
    expect(r.verdict).toBe('rejected');
    expect(r.rejectReason).toBe('no officer or director named');
  });
});

describe('evaluate sync signals', () => {
  it('emits target_metro for an SF Bay company', () => {
    const r = evaluate(filing());
    expect(r.signals.map((s) => s.type)).toContain('target_metro');
  });

  it('emits young_company within the age window', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const r = evaluate(
      filing({ issuer: { ...filing().issuer, yearOfInc: 2025 } }),
      now,
    );
    expect(r.signals.map((s) => s.type)).toContain('young_company');
  });

  it('classifies seed below the seed-max and series_a above it', () => {
    const seed = evaluate(filing({ totalOfferingAmount: 3_000_000 }));
    const seriesA = evaluate(filing({ totalOfferingAmount: 12_000_000 }));
    expect(seed.signals.map((s) => s.type)).toContain('seed');
    expect(seriesA.signals.map((s) => s.type)).toContain('series_a');
  });

  it('does not emit target_metro for an out-of-area company', () => {
    const r = evaluate(
      filing({ issuer: { ...filing().issuer, city: 'Austin', state: 'TX' } }),
    );
    expect(r.signals.map((s) => s.type)).not.toContain('target_metro');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/radar/form-d-filter.test.ts`
Expected: FAIL with "Cannot find module 'app/radar/form-d-filter.js'".

- [ ] **Step 3: Port the implementation**

Copy `spec/src/form-d-filter.ts` to `src/radar/form-d-filter.ts`. Change the import line to `from 'app/radar/config.js'`. Reindent to 2-space. No logic changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/radar/form-d-filter.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/radar/form-d-filter.ts src/__tests__/radar/form-d-filter.test.ts
git commit -m "feat: Form D gate-then-score filter with gate tests"
```

---

## Task 3: Scoring helper, test-first

**Files:**

- Create: `src/radar/scoring.ts`
- Test: `src/__tests__/radar/scoring.test.ts`

Reference: `spec/src/scoring.ts`. `warmthFromSignals` is pure and testable; `LIVE_SCORE_SQL` is exercised later in the queries integration test.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/radar/scoring.test.ts
import { warmthFromSignals } from 'app/radar/scoring.js';
import { describe, expect, it } from 'vitest';

describe('warmthFromSignals', () => {
  it('sums stored signal weights plus the connection weight', () => {
    // hiring_eng(10) + ai_native(8) + direct(20) = 38
    expect(warmthFromSignals([10, 8], 'direct')).toBe(38);
  });

  it('treats an unknown connection strength as zero', () => {
    expect(warmthFromSignals([5], 'unknown')).toBe(5);
  });

  it('returns the connection weight alone when there are no signals', () => {
    expect(warmthFromSignals([], 'recruiter')).toBe(12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/radar/scoring.test.ts`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Port the implementation**

Copy `spec/src/scoring.ts` to `src/radar/scoring.ts`. Change import to `from 'app/radar/config.js'`. Reindent. No logic changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/radar/scoring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/radar/scoring.ts src/__tests__/radar/scoring.test.ts
git commit -m "feat: warmth scoring helper"
```

---

## Task 4: Pure parsers (daily index + Form D XML), fixture-tested

**Files:**

- Create: `src/radar/parse.ts`
- Test: `src/__tests__/radar/parse.test.ts`
- Fixtures: `src/__tests__/fixtures/form-d/clean.xml`, `pooled-fund.xml`, `indefinite.xml`, `no-middle-name.xml`, `master-sample.idx`

This extracts the pure parsing from the spec's `edgar-ingest.ts` (the `fetchAndParse` body and the `.idx` line loop) into env-free functions so they can be fixture-tested. The IO wrapper comes in Task 5.

- [ ] **Step 1: Capture fixtures**

Save 4 real `primary_doc.xml` documents into `src/__tests__/fixtures/form-d/`. Pull live examples (one per case) using the SEC archives, e.g.:

```bash
curl -s -A "job-scanner you@example.com" \
  "https://www.sec.gov/Archives/edgar/data/<cik>/<accession-no-dashes>/primary_doc.xml" \
  -o src/__tests__/fixtures/form-d/clean.xml
```

Required cases: `clean.xml` (passes), `pooled-fund.xml` (industryGroupType "Pooled Investment Fund"), `indefinite.xml` (totalOfferingAmount "Indefinite"), `no-middle-name.xml` (related person with no middle name). Also save one daily `master.<date>.idx` slice (a dozen lines including a D and a D/A row) as `master-sample.idx`.

- [ ] **Step 2: Write the failing tests**

```typescript
// src/__tests__/radar/parse.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDailyIndex, parseFormDXml } from 'app/radar/parse.js';
import { describe, expect, it } from 'vitest';

function fixture(name: string): string {
  const url = new URL(`../fixtures/form-d/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}

describe('parseFormDXml', () => {
  it('maps a clean filing to ParsedFormD', () => {
    const parsed = parseFormDXml(fixture('clean.xml'));
    expect(parsed).not.toBeNull();
    expect(parsed!.issuer.name.length).toBeGreaterThan(0);
    expect(parsed!.isPooledFund).toBe(false);
  });

  it('flags a pooled investment fund', () => {
    const parsed = parseFormDXml(fixture('pooled-fund.xml'));
    expect(parsed!.isPooledFund).toBe(true);
  });

  it('maps an Indefinite offering amount to the "indefinite" sentinel', () => {
    const parsed = parseFormDXml(fixture('indefinite.xml'));
    expect(parsed!.totalOfferingAmount).toBe('indefinite');
  });

  it('joins a name with no middle name without a double space', () => {
    const parsed = parseFormDXml(fixture('no-middle-name.xml'));
    expect(parsed!.relatedPersons[0]!.fullName).not.toContain('  ');
  });

  it('returns null for XML without an edgarSubmission root', () => {
    expect(parseFormDXml('<nonsense/>')).toBeNull();
  });
});

describe('parseDailyIndex', () => {
  it('keeps only D and D/A rows and derives the accession number', () => {
    const pointers = parseDailyIndex(fixture('master-sample.idx'));
    expect(pointers.length).toBeGreaterThan(0);
    expect(
      pointers.every((p) => p.formType === 'D' || p.formType === 'D/A'),
    ).toBe(true);
    expect(pointers[0]!.accessionNumber).not.toContain('/');
    expect(pointers[0]!.accessionNumber).not.toContain('.txt');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/radar/parse.test.ts`
Expected: FAIL ("Cannot find module 'app/radar/parse.js'").

- [ ] **Step 4: Implement the pure parsers**

```typescript
// src/radar/parse.ts
import { XMLParser } from 'fast-xml-parser';
import type { ParsedFormD, Relationship } from 'app/radar/form-d-filter.js';

export interface FilingPointer {
  cik: string;
  companyName: string;
  formType: string;
  dateFiled: string;
  accessionNumber: string;
}

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// Parses a daily master.idx body. Lines: CIK|Company|Form Type|Date Filed|Filename
export function parseDailyIndex(body: string): FilingPointer[] {
  const pointers: FilingPointer[] = [];
  for (const line of body.split('\n')) {
    const parts = line.split('|');
    if (parts.length !== 5) continue;
    const [cik, companyName, formType, dateFiled, filename] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (formType !== 'D' && formType !== 'D/A') continue;
    const accessionNumber = filename
      .trim()
      .split('/')
      .pop()!
      .replace(/\.txt$/, '');
    pointers.push({
      cik: cik.trim(),
      companyName: companyName.trim(),
      formType: formType.trim(),
      dateFiled: dateFiled.trim(),
      accessionNumber,
    });
  }
  return pointers;
}

// Maps a primary_doc.xml string to ParsedFormD, or null if not a Form D submission.
// accessionNumber/cik/formType/filingDate come from the index pointer, so the caller
// supplies them; this function fills the rest from the document.
export function parseFormDXml(
  text: string,
  pointer?: Partial<FilingPointer>,
): ParsedFormD | null {
  const root = xml.parse(text)?.edgarSubmission;
  if (!root) return null;

  const issuer = root.primaryIssuer ?? {};
  const addr = issuer.issuerAddress ?? {};
  const offering = root.offeringData ?? {};
  const industry = offering.industryGroup ?? {};
  const sec = offering.typesOfSecuritiesOffered ?? {};
  const amounts = offering.offeringSalesAmounts ?? {};

  const isPooledFund =
    industry.industryGroupType === 'Pooled Investment Fund' ||
    industry.investmentFundInfo !== undefined ||
    sec.isPooledInvestmentFundType === 'true';

  const securitiesTypes: string[] = [];
  if (sec.isEquityType === 'true') securitiesTypes.push('Equity');
  if (sec.isDebtType === 'true') securitiesTypes.push('Debt');
  if (sec.isOptionToAcquireType === 'true')
    securitiesTypes.push('Option/Warrant');
  if (sec.isOtherType === 'true') securitiesTypes.push('Other');

  const raw = amounts.totalOfferingAmount;
  const totalOfferingAmount =
    raw === 'Indefinite' ? 'indefinite' : raw != null ? Number(raw) : null;

  const relatedPersons = asArray<Record<string, unknown>>(
    root.relatedPersonsList?.relatedPersonInfo,
  ).map((rp) => {
    const n = (rp.relatedPersonName ?? {}) as Record<string, string>;
    return {
      fullName: [n.firstName, n.middleName, n.lastName]
        .filter(Boolean)
        .join(' '),
      relationships: asArray<string>(
        (
          rp.relatedPersonRelationshipList as
            | Record<string, unknown>
            | undefined
        )?.relationship as string | string[] | undefined,
      ) as Relationship[],
    };
  });

  const yearVal = issuer.yearOfInc?.value;
  const formType = (pointer?.formType ?? 'D') as 'D' | 'D/A';

  return {
    accessionNumber: pointer?.accessionNumber ?? '',
    cik: pointer?.cik ?? String(issuer.cik ?? ''),
    formType,
    isAmendment:
      formType === 'D/A' ||
      offering.typeOfFiling?.newOrAmendment?.isAmendment === 'true',
    filingDate: pointer?.dateFiled ?? '',
    dateOfFirstSale: offering.typeOfFiling?.dateOfFirstSale?.value ?? null,
    industryGroupType: industry.industryGroupType ?? null,
    isPooledFund,
    securitiesTypes,
    totalOfferingAmount,
    totalAmountSold:
      amounts.totalAmountSold != null ? Number(amounts.totalAmountSold) : null,
    issuer: {
      name: issuer.entityName ?? '',
      entityType: issuer.entityType ?? null,
      yearOfInc: yearVal != null ? Number(yearVal) : null,
      city: addr.city ?? null,
      state: addr.stateOrCountry ?? null,
      zip: addr.zipCode ?? null,
    },
    relatedPersons,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/radar/parse.test.ts`
Expected: PASS. If a fixture assertion fails, fix the fixture choice (not the parser) unless the mapping is genuinely wrong.

- [ ] **Step 6: Commit**

```bash
git add src/radar/parse.ts src/__tests__/radar/parse.test.ts src/__tests__/fixtures/form-d/
git commit -m "feat: pure Form D parsers with fixture suite"
```

---

## Task 5: EDGAR client (throttled fetch)

**Files:**

- Create: `src/radar/edgar-client.ts`

This is the IO layer: throttled `secFetch` with the env User-Agent, `listFormDFilings` (fetch + `parseDailyIndex`), and `fetchAndParse` (fetch + `parseFormDXml`). No unit test (network IO); it is exercised by the backfill smoke run in Task 11.

- [ ] **Step 1: Implement the client**

```typescript
// src/radar/edgar-client.ts
import { env } from 'app/config/env.js';
import { logger } from 'app/utils/logger.js';
import { MIN_REQUEST_SPACING_MS } from 'app/radar/config.js';
import type { ParsedFormD } from 'app/radar/form-d-filter.js';
import {
  parseDailyIndex,
  parseFormDXml,
  type FilingPointer,
} from 'app/radar/parse.js';

const ARCHIVES = 'https://www.sec.gov/Archives';

let lastRequestAt = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function secFetch(url: string, attempt = 0): Promise<Response> {
  const wait = MIN_REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const res = await fetch(url, {
    headers: { 'User-Agent': env.SEC_USER_AGENT },
  });
  if ((res.status === 429 || res.status === 503) && attempt < 4) {
    await sleep(2 ** attempt * 1000);
    return secFetch(url, attempt + 1);
  }
  return res;
}

const quarterOf = (month: number) => Math.floor((month - 1) / 3) + 1;

export async function listFormDFilings(date: string): Promise<FilingPointer[]> {
  const [y, m, d] = date.split('-') as [string, string, string];
  const url = `${ARCHIVES}/edgar/daily-index/${y}/QTR${quarterOf(Number(m))}/master.${y}${m}${d}.idx`;
  const res = await secFetch(url);
  if (res.status === 404) return []; // weekend / holiday
  if (!res.ok) throw new Error(`daily index ${url} -> ${res.status}`);
  return parseDailyIndex(await res.text());
}

export function primaryDocUrl(cik: string, accession: string): string {
  return `${ARCHIVES}/edgar/data/${cik}/${accession.replace(/-/g, '')}/primary_doc.xml`;
}

export async function fetchAndParse(
  p: FilingPointer,
): Promise<ParsedFormD | null> {
  const res = await secFetch(primaryDocUrl(p.cik, p.accessionNumber));
  if (!res.ok) return null;
  return parseFormDXml(await res.text(), p);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/radar/edgar-client.ts
git commit -m "feat: throttled EDGAR client"
```

---

## Task 6: ingestDay orchestration, tested with an in-memory RadarDB

**Files:**

- Create: `src/radar/ingest.ts`
- Test: `src/__tests__/radar/ingest.test.ts`

`ingestDay` is the orchestration the spec defines in `edgar-ingest.ts` step 4. The `RadarDB` interface is a real collaborator, so an in-memory fake is a legitimate test double (the unit under test is `ingestDay`, not the DB). This locks the dedup behavior and the free history signals (`first_raise`, `round_grew`).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/radar/ingest.test.ts
import { ingestDay, type RadarDB } from 'app/radar/ingest.js';
import type { ParsedFormD } from 'app/radar/form-d-filter.js';
import { describe, expect, it, vi } from 'vitest';
import * as client from 'app/radar/edgar-client.js';

function passing(
  cik: string,
  amount: number,
  formType: 'D' | 'D/A' = 'D',
): ParsedFormD {
  return {
    accessionNumber: `${cik}-acc`,
    cik,
    formType,
    isAmendment: formType === 'D/A',
    filingDate: '2026-05-01',
    dateOfFirstSale: null,
    industryGroupType: 'Computers',
    isPooledFund: false,
    securitiesTypes: ['Equity'],
    totalOfferingAmount: amount,
    totalAmountSold: 0,
    issuer: {
      name: 'Acme',
      entityType: 'Corporation',
      yearOfInc: 2025,
      city: 'Austin',
      state: 'TX',
      zip: '78701',
    },
    relatedPersons: [{ fullName: 'A B', relationships: ['Executive Officer'] }],
  };
}

// Minimal in-memory RadarDB recording calls.
function fakeDb(
  opts: { priorCount?: number; priorMax?: number | null } = {},
): RadarDB & {
  upserted: { companyId: number; signals: { type: string }[] }[];
} {
  const upserted: { companyId: number; signals: { type: string }[] }[] = [];
  return {
    upserted,
    filingExists: async () => false,
    priorFilingCount: async () => opts.priorCount ?? 0,
    maxPriorOfferingAmount: async () => opts.priorMax ?? null,
    upsertCompanyFromFiling: async () => 1,
    insertFiling: async () => {},
    upsertSignals: async (companyId, signals) => {
      upserted.push({ companyId, signals });
    },
    recomputeWarmth: async () => {},
  };
}

describe('ingestDay', () => {
  it('emits first_raise when the company has no prior filings', async () => {
    vi.spyOn(client, 'listFormDFilings').mockResolvedValue([
      {
        cik: '1',
        companyName: 'Acme',
        formType: 'D',
        dateFiled: '2026-05-01',
        accessionNumber: '1-acc',
      },
    ]);
    vi.spyOn(client, 'fetchAndParse').mockResolvedValue(
      passing('1', 2_000_000),
    );
    const db = fakeDb({ priorCount: 0 });

    await ingestDay('2026-05-01', db);

    const types = db.upserted[0]!.signals.map((s) => s.type);
    expect(types).toContain('first_raise');
  });

  it('emits round_grew on an amendment that exceeds the prior max', async () => {
    vi.spyOn(client, 'listFormDFilings').mockResolvedValue([
      {
        cik: '2',
        companyName: 'Acme',
        formType: 'D/A',
        dateFiled: '2026-05-01',
        accessionNumber: '2-acc',
      },
    ]);
    vi.spyOn(client, 'fetchAndParse').mockResolvedValue(
      passing('2', 5_000_000, 'D/A'),
    );
    const db = fakeDb({ priorCount: 1, priorMax: 3_000_000 });

    await ingestDay('2026-05-01', db);

    const types = db.upserted[0]!.signals.map((s) => s.type);
    expect(types).toContain('round_grew');
  });

  it('skips a filing whose accession already exists', async () => {
    vi.spyOn(client, 'listFormDFilings').mockResolvedValue([
      {
        cik: '3',
        companyName: 'Acme',
        formType: 'D',
        dateFiled: '2026-05-01',
        accessionNumber: '3-acc',
      },
    ]);
    const fetchSpy = vi.spyOn(client, 'fetchAndParse');
    const db = { ...fakeDb(), filingExists: async () => true };

    const result = await ingestDay('2026-05-01', db);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.passed).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/radar/ingest.test.ts`
Expected: FAIL ("Cannot find module 'app/radar/ingest.js'").

- [ ] **Step 3: Implement ingest.ts**

Port the `RadarDB` interface and `ingestDay` from `spec/src/edgar-ingest.ts` (the interface block and step-4 orchestration). Change imports: filter from `app/radar/form-d-filter.js`, `SIGNAL_WEIGHTS` from `app/radar/config.js`, and `listFormDFilings`/`fetchAndParse` from `app/radar/edgar-client.js`. Keep the orchestration logic identical (dedup on accession, history lookups before insert, first_raise/round_grew, recomputeWarmth). Reindent to 2-space.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/radar/ingest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/radar/ingest.ts src/__tests__/radar/ingest.test.ts
git commit -m "feat: ingestDay orchestration with history-signal tests"
```

---

## Task 7: PgRadarDB (real Postgres implementation), integration-tested

**Files:**

- Create: `src/radar/db.ts`
- Create: `vitest.integration.config.ts`
- Create: `scripts/ensure-test-db.sh`
- Test: `src/__tests__/integration/radar-db.test.ts`

Per R-200, repository tests hit a real database, not a mocked pool. This task wires `PgRadarDB` and proves upsert + recompute against Postgres.

- [ ] **Step 1: Add the integration vitest config**

```typescript
// vitest.integration.config.ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { app: path.resolve(__dirname, './src') } },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/__tests__/integration/**/*.test.ts'],
    setupFiles: ['src/__tests__/helpers/setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
```

Add to `package.json` scripts: `"test:integration": "node --env-file-if-exists=.env.test node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts"`. Add `.env.test` to `.gitignore`.

- [ ] **Step 2: Add the test DB helper**

```bash
# scripts/ensure-test-db.sh
#!/usr/bin/env bash
set -euo pipefail
DB_URL="${TEST_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/job_scanner_test}"
echo "DATABASE_URL=$DB_URL" > .env.test
DATABASE_URL="$DB_URL" npm run migrate:up
```

Mark executable: `chmod +x scripts/ensure-test-db.sh`.

- [ ] **Step 3: Write the failing integration test**

```typescript
// src/__tests__/integration/radar-db.test.ts
import { PgRadarDB } from 'app/radar/db.js';
import { pool, query } from 'app/db/pool.js';
import type { ParsedFormD } from 'app/radar/form-d-filter.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const db = new PgRadarDB();

function filing(cik: string, amount: number): ParsedFormD {
  return {
    accessionNumber: `${cik}-acc`,
    cik,
    formType: 'D',
    isAmendment: false,
    filingDate: '2026-05-01',
    dateOfFirstSale: null,
    industryGroupType: 'Computers',
    isPooledFund: false,
    securitiesTypes: ['Equity'],
    totalOfferingAmount: amount,
    totalAmountSold: 0,
    issuer: {
      name: 'Acme',
      entityType: 'Corporation',
      yearOfInc: 2025,
      city: 'San Francisco',
      state: 'CA',
      zip: '94107',
    },
    relatedPersons: [{ fullName: 'A B', relationships: ['Executive Officer'] }],
  };
}

beforeEach(async () => {
  await query('TRUNCATE companies, filings, signals RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await pool.end();
});

describe('PgRadarDB', () => {
  it('upserts a company on cik and is idempotent', async () => {
    const id1 = await db.upsertCompanyFromFiling(filing('100', 2_000_000));
    const id2 = await db.upsertCompanyFromFiling(filing('100', 2_000_000));
    expect(id1).toBe(id2);
  });

  it('upserts signals without duplicating on (company_id, type)', async () => {
    const id = await db.upsertCompanyFromFiling(filing('101', 2_000_000));
    await db.upsertSignals(id, [{ type: 'seed', weight: 5, source: 'form_d' }]);
    await db.upsertSignals(id, [{ type: 'seed', weight: 5, source: 'form_d' }]);
    const { rows } = await query<{ count: string }>(
      'SELECT count(*) FROM signals WHERE company_id = $1 AND type = $2',
      [id, 'seed'],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('recomputes warmth as the sum of signal weights plus connection', async () => {
    const id = await db.upsertCompanyFromFiling(filing('102', 2_000_000));
    await db.upsertSignals(id, [
      { type: 'seed', weight: 5, source: 'form_d' },
      { type: 'target_metro', weight: 3, source: 'form_d' },
    ]);
    await query(
      "UPDATE companies SET connection_strength = 'direct' WHERE id = $1",
      [id],
    );
    await db.recomputeWarmth(id);
    const { rows } = await query<{ warmth_score: string }>(
      'SELECT warmth_score FROM companies WHERE id = $1',
      [id],
    );
    expect(Number(rows[0]!.warmth_score)).toBe(28); // 5 + 3 + 20
  });

  it('reports prior filing count and max prior offering amount', async () => {
    const id = await db.upsertCompanyFromFiling(filing('103', 2_000_000));
    await db.insertFiling(filing('103', 2_000_000), id, 'passed', null);
    expect(await db.priorFilingCount('103')).toBe(1);
    expect(await db.maxPriorOfferingAmount('103')).toBe(2_000_000);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `./scripts/ensure-test-db.sh && npm run test:integration`
Expected: FAIL ("Cannot find module 'app/radar/db.js'"). (Requires a local Postgres; if none, document and skip per R-201 test-resistant exception.)

- [ ] **Step 5: Implement PgRadarDB**

```typescript
// src/radar/db.ts
import { query } from 'app/db/pool.js';
import { CONNECTION_WEIGHTS } from 'app/radar/config.js';
import type { ParsedFormD } from 'app/radar/form-d-filter.js';
import type { RadarDB, SignalInput } from 'app/radar/ingest.js';
import { primaryDocUrl } from 'app/radar/edgar-client.js';
import { TARGET_METROS } from 'app/radar/config.js';

function inTargetMetro(city: string | null, state: string | null): boolean {
  const c = city?.toLowerCase() ?? '';
  return TARGET_METROS.some((m) => m.state === state && m.cities.has(c));
}

export class PgRadarDB implements RadarDB {
  async filingExists(accession: string): Promise<boolean> {
    const { rows } = await query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM filings WHERE accession_number = $1) AS exists',
      [accession],
    );
    return rows[0]!.exists;
  }

  async priorFilingCount(cik: string): Promise<number> {
    const { rows } = await query<{ count: string }>(
      'SELECT count(*) FROM filings WHERE cik = $1',
      [cik],
    );
    return Number(rows[0]!.count);
  }

  async maxPriorOfferingAmount(cik: string): Promise<number | null> {
    const { rows } = await query<{ max: string | null }>(
      'SELECT max(total_offering_amount) AS max FROM filings WHERE cik = $1',
      [cik],
    );
    return rows[0]!.max == null ? null : Number(rows[0]!.max);
  }

  async upsertCompanyFromFiling(filing: ParsedFormD): Promise<number> {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO companies (cik, name, entity_type, year_of_inc, hq_city, hq_state, in_target_metro, industry_group, latest_filing_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (cik) DO UPDATE SET
         name = EXCLUDED.name,
         latest_filing_date = GREATEST(companies.latest_filing_date, EXCLUDED.latest_filing_date),
         updated_at = now()
       RETURNING id`,
      [
        filing.cik,
        filing.issuer.name,
        filing.issuer.entityType,
        filing.issuer.yearOfInc,
        filing.issuer.city,
        filing.issuer.state,
        inTargetMetro(filing.issuer.city, filing.issuer.state),
        filing.industryGroupType,
        filing.filingDate,
      ],
    );
    return rows[0]!.id;
  }

  async insertFiling(
    filing: ParsedFormD,
    companyId: number | null,
    verdict: 'passed' | 'rejected',
    rejectReason: string | null,
  ): Promise<void> {
    const amount =
      typeof filing.totalOfferingAmount === 'number'
        ? filing.totalOfferingAmount
        : null;
    await query(
      `INSERT INTO filings (accession_number, company_id, cik, form_type, is_amendment, filing_date, industry_group, is_pooled_fund, securities_types, total_offering_amount, total_amount_sold, raw_url, filter_verdict, reject_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (accession_number) DO NOTHING`,
      [
        filing.accessionNumber,
        companyId,
        filing.cik,
        filing.formType,
        filing.isAmendment,
        filing.filingDate,
        filing.industryGroupType,
        filing.isPooledFund,
        filing.securitiesTypes,
        amount,
        filing.totalAmountSold,
        primaryDocUrl(filing.cik, filing.accessionNumber),
        verdict,
        rejectReason,
      ],
    );
  }

  async upsertSignals(
    companyId: number,
    signals: SignalInput[],
  ): Promise<void> {
    for (const s of signals) {
      await query(
        `INSERT INTO signals (company_id, type, weight, source)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, type) DO UPDATE SET weight = EXCLUDED.weight, source = EXCLUDED.source`,
        [companyId, s.type, s.weight, s.source],
      );
    }
  }

  async recomputeWarmth(companyId: number): Promise<void> {
    await query(
      `UPDATE companies c SET warmth_score =
         COALESCE((SELECT sum(weight) FROM signals s WHERE s.company_id = c.id), 0)
         + CASE c.connection_strength
             WHEN 'direct' THEN $2 WHEN 'recruiter' THEN $3 ELSE 0 END
       WHERE c.id = $1`,
      [companyId, CONNECTION_WEIGHTS.direct, CONNECTION_WEIGHTS.recruiter],
    );
  }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm run test:integration`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/radar/db.ts vitest.integration.config.ts scripts/ensure-test-db.sh src/__tests__/integration/radar-db.test.ts package.json .gitignore
git commit -m "feat: PgRadarDB with Postgres integration tests"
```

---

## Task 8: Read queries (outreach queue + reject distribution)

**Files:**

- Create: `src/radar/queries.ts`
- Test: `src/__tests__/integration/queries.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// src/__tests__/integration/queries.test.ts
import { outreachQueue, rejectDistribution } from 'app/radar/queries.js';
import { pool, query } from 'app/db/pool.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

beforeEach(async () => {
  await query('TRUNCATE companies, filings, signals RESTART IDENTITY CASCADE');
});
afterAll(async () => {
  await pool.end();
});

describe('outreachQueue', () => {
  it('adds the intersection premium to a fresh, hiring company', async () => {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO companies (cik, name, warmth_score, status, latest_filing_date)
       VALUES ('900', 'Fresh', 10, 'discovered', current_date) RETURNING id`,
    );
    const id = rows[0]!.id;
    await query(
      "INSERT INTO signals (company_id, type, weight) VALUES ($1, 'hiring_eng', 10)",
      [id],
    );
    const queue = await outreachQueue(15);
    const row = queue.find((r) => r.id === id)!;
    // warmth 10 + recency 10 (<=7d) + intersection 5 = 25
    expect(Number(row.live_score)).toBe(25);
  });
});

describe('rejectDistribution', () => {
  it('counts reject reasons over a window', async () => {
    await query(
      `INSERT INTO filings (accession_number, cik, form_type, filing_date, raw_url, filter_verdict, reject_reason)
       VALUES ('r1', '1', 'D', current_date, 'u', 'rejected', 'pooled investment fund'),
              ('r2', '2', 'D', current_date, 'u', 'rejected', 'pooled investment fund')`,
    );
    const dist = await rejectDistribution(7);
    expect(dist.find((d) => d.reason === 'pooled investment fund')!.count).toBe(
      2,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:integration`
Expected: FAIL ("Cannot find module 'app/radar/queries.js'").

- [ ] **Step 3: Implement queries.ts**

```typescript
// src/radar/queries.ts
import { query } from 'app/db/pool.js';
import { LIVE_SCORE_SQL } from 'app/radar/scoring.js';

export interface QueueRow {
  id: number;
  name: string;
  warmth_score: string;
  live_score: string;
  status: string;
}

export async function outreachQueue(limit = 15): Promise<QueueRow[]> {
  const { rows } = await query<QueueRow>(LIVE_SCORE_SQL, [limit]);
  return rows;
}

export interface RejectRow {
  reason: string;
  count: number;
}

export async function rejectDistribution(days: number): Promise<RejectRow[]> {
  const { rows } = await query<{ reason: string; count: string }>(
    `SELECT reject_reason AS reason, count(*) AS count
       FROM filings
      WHERE filter_verdict = 'rejected'
        AND fetched_at >= current_date - $1::int
      GROUP BY reject_reason
      ORDER BY count DESC`,
    [days],
  );
  return rows.map((r) => ({ reason: r.reason, count: Number(r.count) }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:integration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/radar/queries.ts src/__tests__/integration/queries.test.ts
git commit -m "feat: outreach queue and reject distribution queries"
```

---

## Task 9: Telegram + email services

**Files:**

- Create: `src/services/telegram.ts`
- Create: `src/services/email.ts`

Both are thin and no-op when their env vars are absent, so jobs run locally without secrets. No unit tests (external IO, excluded from coverage like the template excludes service clients).

- [ ] **Step 1: Implement telegram.ts**

```typescript
// src/services/telegram.ts
import { env } from 'app/config/env.js';
import { logger } from 'app/utils/logger.js';

// Fire-and-log alert. No-op (with a warning) when Telegram is not configured.
export async function sendAlert(text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    logger.warn({ text }, 'telegram not configured; alert dropped');
    return;
  }
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
  } catch (err) {
    logger.error({ err }, 'telegram send failed');
  }
}
```

- [ ] **Step 2: Implement email.ts**

```typescript
// src/services/email.ts
import { env } from 'app/config/env.js';
import { logger } from 'app/utils/logger.js';
import { Resend } from 'resend';

export async function sendDigest(subject: string, html: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.DIGEST_TO_EMAIL) {
    logger.warn('resend not configured; digest not sent');
    return;
  }
  const resend = new Resend(env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: env.DIGEST_TO_EMAIL,
    subject,
    html,
  });
  if (error) logger.error({ error }, 'digest send failed');
}
```

Add `resend` to dependencies: `npm install resend@^6.11.0`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/services/telegram.ts src/services/email.ts package.json package-lock.json
git commit -m "feat: telegram alert and resend digest services"
```

---

## Task 10: Heartbeat job wrapper, test-first

**Files:**

- Create: `src/jobs/runJob.ts`
- Test: `src/__tests__/jobs/runJob.test.ts`

`runJob` is the dead-man's-switch: it runs a job function, logs the outcome, alerts via Telegram on throw, and sets the process exit code. The unit test asserts the alert fires on failure (the heartbeat behavior) without exiting the test process.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/jobs/runJob.test.ts
import { runJob } from 'app/jobs/runJob.js';
import * as telegram from 'app/services/telegram.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('runJob', () => {
  it('alerts and sets a non-zero exit code when the job throws', async () => {
    const alert = vi.spyOn(telegram, 'sendAlert').mockResolvedValue();
    await runJob('edgar-ingest', async () => {
      throw new Error('boom');
    });
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0]![0]).toContain('edgar-ingest');
    expect(process.exitCode).toBe(1);
  });

  it('does not alert and leaves exit code 0 on success', async () => {
    const alert = vi.spyOn(telegram, 'sendAlert').mockResolvedValue();
    await runJob('edgar-ingest', async () => {});
    expect(alert).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/jobs/runJob.test.ts`
Expected: FAIL ("Cannot find module 'app/jobs/runJob.js'").

- [ ] **Step 3: Implement runJob.ts**

```typescript
// src/jobs/runJob.ts
import { logger } from 'app/utils/logger.js';
import { sendAlert } from 'app/services/telegram.js';

// Heartbeat wrapper for cron entrypoints. A job that throws fires a Telegram
// alert and sets a non-zero exit code so the failure is visible.
export async function runJob(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  const start = Date.now();
  logger.info({ job: name }, 'job started');
  try {
    await fn();
    logger.info({ job: name, ms: Date.now() - start }, 'job finished');
  } catch (err) {
    logger.error({ job: name, err }, 'job failed');
    await sendAlert(`[job-scanner] job "${name}" failed: ${String(err)}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/jobs/runJob.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/runJob.ts src/__tests__/jobs/runJob.test.ts
git commit -m "feat: heartbeat job wrapper"
```

---

## Task 11: Job entrypoints (edgar-ingest, backfill)

**Files:**

- Create: `src/jobs/edgar-ingest.ts`
- Create: `src/jobs/backfill.ts`

Entrypoints are thin: load env, build the date(s), call `ingestDay` inside `runJob`. They are excluded from coverage (process entrypoints) and verified by a manual smoke run.

- [ ] **Step 1: Implement edgar-ingest entrypoint**

```typescript
// src/jobs/edgar-ingest.ts
import 'dotenv/config';
import { logger } from 'app/utils/logger.js';
import { ingestDay } from 'app/radar/ingest.js';
import { PgRadarDB } from 'app/radar/db.js';
import { runJob } from 'app/jobs/runJob.js';

function yesterdayIso(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

await runJob('edgar-ingest', async () => {
  const date = process.argv[2] ?? yesterdayIso();
  const result = await ingestDay(date, new PgRadarDB());
  logger.info({ date, ...result }, 'ingest complete');
});
```

- [ ] **Step 2: Implement backfill entrypoint**

```typescript
// src/jobs/backfill.ts
import 'dotenv/config';
import { logger } from 'app/utils/logger.js';
import { ingestDay } from 'app/radar/ingest.js';
import { PgRadarDB } from 'app/radar/db.js';
import { runJob } from 'app/jobs/runJob.js';

// Usage: node dist/jobs/backfill.js [days=45]
await runJob('backfill', async () => {
  const days = Number(process.argv[2] ?? 45);
  const db = new PgRadarDB();
  let totalPassed = 0;
  for (let i = days; i >= 1; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const result = await ingestDay(date, db);
    totalPassed += result.passed;
    logger.info({ date, ...result }, 'backfill day complete');
  }
  logger.info({ days, totalPassed }, 'backfill complete');
});
```

- [ ] **Step 3: Build and smoke-run a single day**

Run:

```bash
npm run build
node dist/jobs/edgar-ingest.js 2026-05-01
```

Expected: logs "ingest complete" with a seen/passed count and no throw (requires `.env` with `DATABASE_URL` and `SEC_USER_AGENT`, plus the migration applied). Verify rows landed: `psql "$DATABASE_URL" -c 'select count(*) from companies; select filter_verdict, count(*) from filings group by 1;'`.

- [ ] **Step 4: Commit**

```bash
git add src/jobs/edgar-ingest.ts src/jobs/backfill.ts
git commit -m "feat: edgar-ingest and backfill job entrypoints"
```

---

## Task 12: Weekly digest entrypoint

**Files:**

- Create: `src/jobs/weekly-digest.ts`
- Create: `src/radar/digest.ts`
- Test: `src/__tests__/radar/digest.test.ts`

The digest HTML builder is pure (data in, HTML out) and unit-tested. The entrypoint wires the queries and the email service.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/radar/digest.test.ts
import { buildDigestHtml } from 'app/radar/digest.js';
import { describe, expect, it } from 'vitest';

describe('buildDigestHtml', () => {
  it('lists each queue row and the reject distribution', () => {
    const html = buildDigestHtml(
      [
        {
          id: 1,
          name: 'Acme AI',
          warmth_score: '20',
          live_score: '35',
          status: 'discovered',
        },
      ],
      [{ reason: 'pooled investment fund', count: 4 }],
    );
    expect(html).toContain('Acme AI');
    expect(html).toContain('35');
    expect(html).toContain('pooled investment fund');
    expect(html).toContain('4');
  });

  it('renders a friendly message when the queue is empty', () => {
    const html = buildDigestHtml([], []);
    expect(html.toLowerCase()).toContain('no companies');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/radar/digest.test.ts`
Expected: FAIL ("Cannot find module 'app/radar/digest.js'").

- [ ] **Step 3: Implement digest.ts**

```typescript
// src/radar/digest.ts
import type { QueueRow } from 'app/radar/queries.js';
import type { RejectRow } from 'app/radar/queries.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildDigestHtml(
  queue: QueueRow[],
  rejects: RejectRow[],
): string {
  if (queue.length === 0) {
    return '<p>No companies in the outreach queue this week.</p>';
  }
  const rows = queue
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.status)}</td><td>${escapeHtml(r.live_score)}</td></tr>`,
    )
    .join('');
  const rejectLines = rejects
    .map((r) => `${escapeHtml(r.reason)}: ${r.count}`)
    .join('<br/>');
  return `
    <h2>Outreach queue</h2>
    <table border="1" cellpadding="6"><tr><th>Company</th><th>Status</th><th>Score</th></tr>${rows}</table>
    <h3>Rejects this week</h3>
    <p>${rejectLines || 'none'}</p>
  `;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/radar/digest.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the entrypoint**

```typescript
// src/jobs/weekly-digest.ts
import 'dotenv/config';
import { outreachQueue, rejectDistribution } from 'app/radar/queries.js';
import { buildDigestHtml } from 'app/radar/digest.js';
import { sendDigest } from 'app/services/email.js';
import { runJob } from 'app/jobs/runJob.js';

await runJob('weekly-digest', async () => {
  const [queue, rejects] = await Promise.all([
    outreachQueue(15),
    rejectDistribution(7),
  ]);
  await sendDigest(
    'Job Scanner: weekly outreach queue',
    buildDigestHtml(queue, rejects),
  );
});
```

- [ ] **Step 6: Commit**

```bash
git add src/radar/digest.ts src/jobs/weekly-digest.ts src/__tests__/radar/digest.test.ts
git commit -m "feat: weekly digest builder and entrypoint"
```

---

## Task 13: Railway cron + deploy config

**Files:**

- Create: `railway.toml`
- Create: `Dockerfile`
- Create: `.dockerignore`
- Modify: `README.md` (cron schedule table)

- [ ] **Step 1: Add the Dockerfile**

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Add .dockerignore**

```
node_modules
dist
.env
.env.*
coverage
```

- [ ] **Step 3: Add railway.toml (web service health check)**

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"

[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 120
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 5
```

- [ ] **Step 4: Document the cron schedule in README**

Add a table documenting the Railway cron services (each a separate Railway cron pointing at a start command): `edgar-ingest` daily 06:00 (`node dist/jobs/edgar-ingest.js`), `weekly-digest` Mon 13:00 (`node dist/jobs/weekly-digest.js`), and the one-time `backfill` (`node dist/jobs/backfill.js 45`). Note that the heartbeat is built into `runJob`, so a job that dies fires a Telegram alert.

- [ ] **Step 5: Build-smoke and commit**

Run: `npm run build && test -f dist/jobs/edgar-ingest.js && echo OK`
Expected: `OK`.

```bash
git add railway.toml Dockerfile .dockerignore README.md
git commit -m "feat: Railway cron and deploy config for phase 1"
```

---

## Self-Review

**Spec coverage (section 10, step 1):**

- Run the migration: done in scaffold (0001_radar_init).
- Wire the data layer: Task 7 (PgRadarDB).
- Schedule edgar-ingest: Tasks 11, 13.
- Backfill 30 to 60 days: Task 11 (`backfill.ts`, default 45).
- Email the outreach-queue query + reject distribution: Tasks 8, 12.
- Wire the heartbeat alert: Tasks 9, 10 (`sendAlert` + `runJob`).
- Parser fixture suite: Task 4.
- Filter labeled set: Task 2 (gate tests; the labeled gold set grows from `filings.reject_reason` post-deploy).
- first_raise and round_grew free: Task 6 (tested).

**Gaps deferred (by design, not Phase 1):** ATS `tracked_boards` seeding (Phase 2), `connection_strength` capture UI (Phase 3 CRM; until then set by hand via SQL), `ai_native`/`yc_batch` enrichment (Phase 3).

**Type consistency:** `RadarDB`/`SignalInput` defined in `ingest.ts` (Task 6), implemented in `db.ts` (Task 7). `QueueRow`/`RejectRow` defined in `queries.ts` (Task 8), consumed in `digest.ts` (Task 12). `ParsedFormD`/`Relationship` owned by `form-d-filter.ts` (Task 2), consumed by `parse.ts` (Task 4) and `db.ts`. `FilingPointer` owned by `parse.ts`, consumed by `edgar-client.ts`.
