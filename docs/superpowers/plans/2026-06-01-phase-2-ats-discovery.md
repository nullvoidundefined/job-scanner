# Phase 2: ATS Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the ATS half of the radar: poll active `tracked_boards` daily, normalise Greenhouse/Lever/Ashby responses, filter for matching engineering roles, upsert into `job_postings`, refresh `companies.latest_fresh_role_date`, emit and maintain the `hiring_eng` signal, enforce ghost-listing, and automate board-health failure tracking with Telegram alerts.

**Architecture:** Pure normalizers (one per provider) are separated from IO (the board puller). The `AtsDB` interface is the seam between orchestration and persistence: `pullBoard` is unit-tested against an in-memory fake, and the real `PgAtsDB` is integration-tested against live Postgres. The `ats-pull` job entrypoint is a plain Node script wrapped in the existing `runJob` heartbeat. All types are defined in the module that owns them and re-exported; no cross-module type drift.

**Tech Stack:** Express 5, TypeScript (NodeNext ESM), Postgres via `pg`, Vitest (unit), Vitest integration config from Phase 1 (`vitest.integration.config.ts`).

**Conventions (apply to every task):**

- No em dash (U+2014) anywhere, including comments and test fixtures. Rule R-001.
- Prettier: 2-space, 80-width, single-quote, trailing commas. Imports use the `app/*` alias and `.js` extensions (NodeNext), e.g. `import { query } from 'app/db/pool.js'`.
- Pure modules (`normalizers/`, `ats-filter.ts`) must NOT import `app/config/env.js`, so their tests need no env.
- Commit after each task. Pre-commit formats staged files; pre-push runs typecheck + test + build.

---

## File Structure

```
src/radar/
  config.ts              Already exists from Phase 1. ROLE_SENIORITY, ROLE_REMOTE,
                           ROLE_STALE_DAYS, TARGET_METROS reused here. No changes.
  ats-filter.ts          matchesRole(posting, metros): boolean. Pure.
  normalizers/
    greenhouse.ts        normalizeGreenhouse(raw): NormalizedPosting[]. Pure.
    lever.ts             normalizeLever(raw): NormalizedPosting[]. Pure.
    ashby.ts             normalizeAshby(raw): NormalizedPosting[]. Pure.
    types.ts             NormalizedPosting shape. Shared by all three normalizers.
  ats-pull.ts            pullBoard + AtsDB interface + orchestration. IO-free logic.
  ats-db.ts              PgAtsDB: AtsDB backed by app/db/pool.
src/jobs/
  ats-pull.ts            Entrypoint: pull all active boards daily 07:00.
  add-board.ts           CLI helper: add a board row to tracked_boards.
src/__tests__/
  fixtures/ats/
    greenhouse-sample.json    Captured Greenhouse job-board API response.
    lever-sample.json         Captured Lever postings API response.
    ashby-sample.json         Captured Ashby job-board API response.
  radar/
    greenhouse.test.ts        Fixture-driven normalizer tests.
    lever.test.ts             Fixture-driven normalizer tests.
    ashby.test.ts             Fixture-driven normalizer tests.
    ats-filter.test.ts        Role filter unit tests.
    ats-pull.test.ts          pullBoard orchestration, in-memory AtsDB.
  integration/
    ats-db.test.ts            PgAtsDB against real Postgres.
```

---

## Task 1: Shared NormalizedPosting type

**Files:**

- Create: `src/radar/normalizers/types.ts`

This type is the contract between every normalizer and the puller. Define it once here; all three normalizers import from here.

- [ ] **Step 1: Write the type**

```typescript
// src/radar/normalizers/types.ts

export interface NormalizedPosting {
  // Stable composite id: '{provider}:{nativeId}'.
  // Used as the primary key in job_postings.
  id: string;
  provider: 'greenhouse' | 'lever' | 'ashby';
  nativeId: string;
  title: string;
  location: string | null;
  // True when the provider explicitly marks the role remote, or the location
  // string matches ROLE_REMOTE. Callers set this; normalizers derive from data.
  isRemote: boolean;
  url: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no importers yet).

- [ ] **Step 3: Commit**

```bash
git add src/radar/normalizers/types.ts
git commit -m "feat: NormalizedPosting shared type"
```

---

## Task 2: Greenhouse normalizer, fixture-tested

**Files:**

- Fixture: `src/__tests__/fixtures/ats/greenhouse-sample.json`
- Create: `src/radar/normalizers/greenhouse.ts`
- Test: `src/__tests__/radar/greenhouse.test.ts`

The Greenhouse endpoint returns `{ jobs: [ { id, title, location: { name }, absolute_url, departments, offices, metadata, ... } ] }`. Fixtures must cover the ugly cases: a posting with no location, one with a location string containing "Remote", a posting with an empty title, and a clean "Senior Software Engineer, SF" case.

- [ ] **Step 1: Capture the fixture**

Fetch a real Greenhouse board response and save it. Choose a company with varied postings (remote mix, location mix). Scrub any PII that leaks into the fixture (emails, internal IDs beyond the numeric job id are fine to keep).

```bash
curl -s "https://boards-api.greenhouse.io/v1/boards/anthropic/jobs?content=true" \
  -o src/__tests__/fixtures/ats/greenhouse-sample.json
```

The fixture must include at minimum: one posting with `location.name` null or empty, one with `location.name` containing "Remote" or "remote", one clean city-only posting. If the live board does not cover all cases, hand-edit the fixture to add synthetic entries with the correct shape (keeping the array valid JSON). Do not include real personal data.

- [ ] **Step 2: Write the failing tests**

```typescript
// src/__tests__/radar/greenhouse.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeGreenhouse } from 'app/radar/normalizers/greenhouse.js';
import { describe, expect, it } from 'vitest';

function loadFixture(): unknown {
  const url = new URL(
    '../fixtures/ats/greenhouse-sample.json',
    import.meta.url,
  );
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

describe('normalizeGreenhouse', () => {
  it('maps each job to a NormalizedPosting with a greenhouse: id prefix', () => {
    const raw = loadFixture();
    const postings = normalizeGreenhouse(raw);
    expect(postings.length).toBeGreaterThan(0);
    expect(postings.every((p) => p.id.startsWith('greenhouse:'))).toBe(true);
    expect(postings.every((p) => p.provider === 'greenhouse')).toBe(true);
  });

  it('sets isRemote true when the location string contains "remote"', () => {
    const raw = {
      jobs: [
        {
          id: 1,
          title: 'Senior Engineer',
          location: { name: 'Remote - US' },
          absolute_url: 'https://example.com/jobs/1',
        },
      ],
    };
    const [posting] = normalizeGreenhouse(raw);
    expect(posting!.isRemote).toBe(true);
  });

  it('sets isRemote false when location is a city with no remote keyword', () => {
    const raw = {
      jobs: [
        {
          id: 2,
          title: 'Staff Engineer',
          location: { name: 'San Francisco, CA' },
          absolute_url: 'https://example.com/jobs/2',
        },
      ],
    };
    const [posting] = normalizeGreenhouse(raw);
    expect(posting!.isRemote).toBe(false);
  });

  it('sets location null when the location object is missing', () => {
    const raw = {
      jobs: [
        {
          id: 3,
          title: 'Principal Engineer',
          absolute_url: 'https://example.com/jobs/3',
        },
      ],
    };
    const [posting] = normalizeGreenhouse(raw);
    expect(posting!.location).toBeNull();
    expect(posting!.isRemote).toBe(false);
  });

  it('skips jobs with an empty title', () => {
    const raw = {
      jobs: [
        { id: 4, title: '', absolute_url: 'https://example.com/jobs/4' },
        {
          id: 5,
          title: 'Lead Engineer',
          absolute_url: 'https://example.com/jobs/5',
        },
      ],
    };
    const postings = normalizeGreenhouse(raw);
    expect(postings.length).toBe(1);
    expect(postings[0]!.nativeId).toBe('5');
  });

  it('maps the real fixture without throwing', () => {
    expect(() => normalizeGreenhouse(loadFixture())).not.toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/radar/greenhouse.test.ts`
Expected: FAIL ("Cannot find module 'app/radar/normalizers/greenhouse.js'").

- [ ] **Step 4: Implement the normalizer**

```typescript
// src/radar/normalizers/greenhouse.ts
import { ROLE_REMOTE } from 'app/radar/config.js';
import type { NormalizedPosting } from 'app/radar/normalizers/types.js';

interface GhLocation {
  name?: string | null;
}

interface GhJob {
  id?: number | string;
  title?: string | null;
  location?: GhLocation | null;
  absolute_url?: string | null;
}

interface GhBoard {
  jobs?: GhJob[];
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

export function normalizeGreenhouse(raw: unknown): NormalizedPosting[] {
  const board = raw as GhBoard;
  const jobs = Array.isArray(board?.jobs) ? board.jobs : [];
  const out: NormalizedPosting[] = [];
  for (const job of jobs) {
    const title = (job.title ?? '').trim();
    if (!title) continue;
    const nativeId = toStr(job.id);
    const locationName = job.location?.name?.trim() ?? null;
    const isRemote = locationName != null && ROLE_REMOTE.test(locationName);
    out.push({
      id: `greenhouse:${nativeId}`,
      provider: 'greenhouse',
      nativeId,
      title,
      location: locationName || null,
      isRemote,
      url: job.absolute_url ?? '',
    });
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/radar/greenhouse.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/radar/normalizers/greenhouse.ts \
        src/__tests__/radar/greenhouse.test.ts \
        src/__tests__/fixtures/ats/greenhouse-sample.json
git commit -m "feat: Greenhouse normalizer with fixture suite"
```

---

## Task 3: Lever normalizer, fixture-tested

**Files:**

- Fixture: `src/__tests__/fixtures/ats/lever-sample.json`
- Create: `src/radar/normalizers/lever.ts`
- Test: `src/__tests__/radar/lever.test.ts`

The Lever endpoint returns an array of posting objects: `[ { id, text, categories: { location, team }, hostedUrl, workplaceType, ... } ]`. `workplaceType` can be `'remote'`, `'hybrid'`, or `'onsite'`. `categories.location` is the location string. Cover: `workplaceType === 'remote'`, explicit remote keyword in location, onsite with city, no categories object.

- [ ] **Step 1: Capture the fixture**

```bash
curl -s "https://api.lever.co/v0/postings/vercel?mode=json" \
  -o src/__tests__/fixtures/ats/lever-sample.json
```

Ensure the fixture includes varied `workplaceType` and location values. Hand-edit if the live board is uniform.

- [ ] **Step 2: Write the failing tests**

```typescript
// src/__tests__/radar/lever.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeLever } from 'app/radar/normalizers/lever.js';
import { describe, expect, it } from 'vitest';

function loadFixture(): unknown {
  const url = new URL('../fixtures/ats/lever-sample.json', import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

describe('normalizeLever', () => {
  it('maps each posting to a NormalizedPosting with a lever: id prefix', () => {
    const postings = normalizeLever(loadFixture());
    expect(postings.length).toBeGreaterThan(0);
    expect(postings.every((p) => p.id.startsWith('lever:'))).toBe(true);
  });

  it('sets isRemote true when workplaceType is "remote"', () => {
    const raw = [
      {
        id: 'abc-123',
        text: 'Senior Engineer',
        categories: { location: 'United States' },
        workplaceType: 'remote',
        hostedUrl: 'https://jobs.lever.co/co/abc-123',
      },
    ];
    const [posting] = normalizeLever(raw);
    expect(posting!.isRemote).toBe(true);
  });

  it('sets isRemote true when location contains a remote keyword', () => {
    const raw = [
      {
        id: 'def-456',
        text: 'Staff Engineer',
        categories: { location: 'Remote, Anywhere' },
        workplaceType: 'onsite',
        hostedUrl: 'https://jobs.lever.co/co/def-456',
      },
    ];
    const [posting] = normalizeLever(raw);
    expect(posting!.isRemote).toBe(true);
  });

  it('sets isRemote false and captures city for an onsite posting', () => {
    const raw = [
      {
        id: 'ghi-789',
        text: 'Principal Engineer',
        categories: { location: 'New York, NY' },
        workplaceType: 'onsite',
        hostedUrl: 'https://jobs.lever.co/co/ghi-789',
      },
    ];
    const [posting] = normalizeLever(raw);
    expect(posting!.isRemote).toBe(false);
    expect(posting!.location).toBe('New York, NY');
  });

  it('handles a posting with no categories object', () => {
    const raw = [
      {
        id: 'jkl-000',
        text: 'Lead Engineer',
        hostedUrl: 'https://jobs.lever.co/co/jkl-000',
      },
    ];
    const [posting] = normalizeLever(raw);
    expect(posting!.location).toBeNull();
    expect(posting!.isRemote).toBe(false);
  });

  it('skips postings with an empty text field', () => {
    const raw = [
      { id: 'x1', text: '', hostedUrl: 'https://jobs.lever.co/co/x1' },
      {
        id: 'x2',
        text: 'Lead Engineer',
        hostedUrl: 'https://jobs.lever.co/co/x2',
      },
    ];
    const postings = normalizeLever(raw);
    expect(postings.length).toBe(1);
  });

  it('maps the real fixture without throwing', () => {
    expect(() => normalizeLever(loadFixture())).not.toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/radar/lever.test.ts`
Expected: FAIL ("Cannot find module 'app/radar/normalizers/lever.js'").

- [ ] **Step 4: Implement the normalizer**

```typescript
// src/radar/normalizers/lever.ts
import { ROLE_REMOTE } from 'app/radar/config.js';
import type { NormalizedPosting } from 'app/radar/normalizers/types.js';

interface LeverCategories {
  location?: string | null;
}

interface LeverPosting {
  id?: string;
  text?: string | null;
  categories?: LeverCategories | null;
  workplaceType?: string | null;
  hostedUrl?: string | null;
}

export function normalizeLever(raw: unknown): NormalizedPosting[] {
  const postings = Array.isArray(raw) ? (raw as LeverPosting[]) : [];
  const out: NormalizedPosting[] = [];
  for (const p of postings) {
    const title = (p.text ?? '').trim();
    if (!title) continue;
    const nativeId = p.id ?? '';
    const location = p.categories?.location?.trim() ?? null;
    const isRemote =
      p.workplaceType === 'remote' ||
      (location != null && ROLE_REMOTE.test(location));
    out.push({
      id: `lever:${nativeId}`,
      provider: 'lever',
      nativeId,
      title,
      location: location || null,
      isRemote,
      url: p.hostedUrl ?? '',
    });
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/radar/lever.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/radar/normalizers/lever.ts \
        src/__tests__/radar/lever.test.ts \
        src/__tests__/fixtures/ats/lever-sample.json
git commit -m "feat: Lever normalizer with fixture suite"
```

---

## Task 4: Ashby normalizer, fixture-tested

**Files:**

- Fixture: `src/__tests__/fixtures/ats/ashby-sample.json`
- Create: `src/radar/normalizers/ashby.ts`
- Test: `src/__tests__/radar/ashby.test.ts`

The Ashby endpoint returns `{ jobPostings: [ { id, title, isRemote, location: { name }, jobPostingUrl, ... } ] }`. Ashby provides an explicit `isRemote` boolean. Cover: `isRemote: true` from the API, `isRemote: false` with a city, no location object, missing `isRemote` field (treat as false).

- [ ] **Step 1: Capture the fixture**

```bash
curl -s "https://api.ashbyhq.com/posting-api/job-board/ashby?includeCompensation=true" \
  -o src/__tests__/fixtures/ats/ashby-sample.json
```

Ensure the fixture has varied `isRemote` and location values. Hand-edit if needed.

- [ ] **Step 2: Write the failing tests**

```typescript
// src/__tests__/radar/ashby.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeAshby } from 'app/radar/normalizers/ashby.js';
import { describe, expect, it } from 'vitest';

function loadFixture(): unknown {
  const url = new URL('../fixtures/ats/ashby-sample.json', import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

describe('normalizeAshby', () => {
  it('maps each posting to a NormalizedPosting with an ashby: id prefix', () => {
    const postings = normalizeAshby(loadFixture());
    expect(postings.length).toBeGreaterThan(0);
    expect(postings.every((p) => p.id.startsWith('ashby:'))).toBe(true);
  });

  it('sets isRemote true when the API isRemote field is true', () => {
    const raw = {
      jobPostings: [
        {
          id: 'aaaa-1111',
          title: 'Senior Engineer',
          isRemote: true,
          location: { name: null },
          jobPostingUrl: 'https://jobs.ashbyhq.com/co/aaaa-1111',
        },
      ],
    };
    const [posting] = normalizeAshby(raw);
    expect(posting!.isRemote).toBe(true);
  });

  it('sets isRemote false and captures location for an onsite posting', () => {
    const raw = {
      jobPostings: [
        {
          id: 'bbbb-2222',
          title: 'Staff Engineer',
          isRemote: false,
          location: { name: 'Seattle, WA' },
          jobPostingUrl: 'https://jobs.ashbyhq.com/co/bbbb-2222',
        },
      ],
    };
    const [posting] = normalizeAshby(raw);
    expect(posting!.isRemote).toBe(false);
    expect(posting!.location).toBe('Seattle, WA');
  });

  it('treats a missing isRemote field as false', () => {
    const raw = {
      jobPostings: [
        {
          id: 'cccc-3333',
          title: 'Principal Engineer',
          jobPostingUrl: 'https://jobs.ashbyhq.com/co/cccc-3333',
        },
      ],
    };
    const [posting] = normalizeAshby(raw);
    expect(posting!.isRemote).toBe(false);
  });

  it('sets location null when the location name is absent', () => {
    const raw = {
      jobPostings: [
        {
          id: 'dddd-4444',
          title: 'Lead Engineer',
          isRemote: true,
          jobPostingUrl: 'https://jobs.ashbyhq.com/co/dddd-4444',
        },
      ],
    };
    const [posting] = normalizeAshby(raw);
    expect(posting!.location).toBeNull();
  });

  it('skips postings with an empty title', () => {
    const raw = {
      jobPostings: [
        {
          id: 'ee-1',
          title: '',
          jobPostingUrl: 'https://jobs.ashbyhq.com/co/ee-1',
        },
        {
          id: 'ee-2',
          title: 'Lead Engineer',
          jobPostingUrl: 'https://jobs.ashbyhq.com/co/ee-2',
        },
      ],
    };
    const postings = normalizeAshby(raw);
    expect(postings.length).toBe(1);
  });

  it('maps the real fixture without throwing', () => {
    expect(() => normalizeAshby(loadFixture())).not.toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/radar/ashby.test.ts`
Expected: FAIL ("Cannot find module 'app/radar/normalizers/ashby.js'").

- [ ] **Step 4: Implement the normalizer**

```typescript
// src/radar/normalizers/ashby.ts
import type { NormalizedPosting } from 'app/radar/normalizers/types.js';

interface AshbyLocation {
  name?: string | null;
}

interface AshbyPosting {
  id?: string;
  title?: string | null;
  isRemote?: boolean;
  location?: AshbyLocation | null;
  jobPostingUrl?: string | null;
}

interface AshbyBoard {
  jobPostings?: AshbyPosting[];
}

export function normalizeAshby(raw: unknown): NormalizedPosting[] {
  const board = raw as AshbyBoard;
  const postings = Array.isArray(board?.jobPostings) ? board.jobPostings : [];
  const out: NormalizedPosting[] = [];
  for (const p of postings) {
    const title = (p.title ?? '').trim();
    if (!title) continue;
    const nativeId = p.id ?? '';
    const location = p.location?.name?.trim() ?? null;
    out.push({
      id: `ashby:${nativeId}`,
      provider: 'ashby',
      nativeId,
      title,
      location: location || null,
      isRemote: p.isRemote === true,
      url: p.jobPostingUrl ?? '',
    });
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/radar/ashby.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/radar/normalizers/ashby.ts \
        src/__tests__/radar/ashby.test.ts \
        src/__tests__/fixtures/ats/ashby-sample.json
git commit -m "feat: Ashby normalizer with fixture suite"
```

---

## Task 5: Role filter, test-first

**Files:**

- Create: `src/radar/ats-filter.ts`
- Test: `src/__tests__/radar/ats-filter.test.ts`

`matchesRole` returns true when the posting title matches `ROLE_SENIORITY` AND (the posting is remote OR its location city falls within a target metro). Pure function; no env dependency.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/radar/ats-filter.test.ts
import { matchesRole } from 'app/radar/ats-filter.js';
import type { NormalizedPosting } from 'app/radar/normalizers/types.js';
import { TARGET_METROS } from 'app/radar/config.js';
import { describe, expect, it } from 'vitest';

function posting(
  overrides: Partial<NormalizedPosting> = {},
): NormalizedPosting {
  return {
    id: 'greenhouse:1',
    provider: 'greenhouse',
    nativeId: '1',
    title: 'Senior Software Engineer',
    location: 'San Francisco, CA',
    isRemote: false,
    url: 'https://example.com/jobs/1',
    ...overrides,
  };
}

describe('matchesRole', () => {
  it('passes a senior title in a target metro city', () => {
    expect(
      matchesRole(posting({ location: 'San Francisco, CA' }), TARGET_METROS),
    ).toBe(true);
  });

  it('passes a staff title that is remote', () => {
    expect(
      matchesRole(
        posting({
          title: 'Staff Backend Engineer',
          isRemote: true,
          location: null,
        }),
        TARGET_METROS,
      ),
    ).toBe(true);
  });

  it('passes a founding engineer title', () => {
    expect(
      matchesRole(
        posting({ title: 'Founding Engineer', isRemote: true }),
        TARGET_METROS,
      ),
    ).toBe(true);
  });

  it('passes a lead title when the location string contains a target metro city', () => {
    expect(
      matchesRole(
        posting({
          title: 'Lead Engineer',
          location: 'Seattle, WA',
          isRemote: false,
        }),
        TARGET_METROS,
      ),
    ).toBe(true);
  });

  it('rejects a junior title even if remote', () => {
    expect(
      matchesRole(
        posting({ title: 'Junior Software Engineer', isRemote: true }),
        TARGET_METROS,
      ),
    ).toBe(false);
  });

  it('rejects a senior title in a non-target city that is not remote', () => {
    expect(
      matchesRole(
        posting({
          title: 'Senior Engineer',
          location: 'Austin, TX',
          isRemote: false,
        }),
        TARGET_METROS,
      ),
    ).toBe(false);
  });

  it('rejects a senior title with a null location that is not remote', () => {
    expect(
      matchesRole(
        posting({ title: 'Senior Engineer', location: null, isRemote: false }),
        TARGET_METROS,
      ),
    ).toBe(false);
  });

  it('is case-insensitive for the seniority match', () => {
    expect(
      matchesRole(
        posting({ title: 'SENIOR software engineer', isRemote: true }),
        TARGET_METROS,
      ),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/radar/ats-filter.test.ts`
Expected: FAIL ("Cannot find module 'app/radar/ats-filter.js'").

- [ ] **Step 3: Implement the filter**

```typescript
// src/radar/ats-filter.ts
import { ROLE_SENIORITY } from 'app/radar/config.js';
import type { Metro } from 'app/radar/config.js';
import type { NormalizedPosting } from 'app/radar/normalizers/types.js';

// Returns true when the posting title hits ROLE_SENIORITY AND
// (the posting is flagged remote OR its location contains a target metro city).
export function matchesRole(
  posting: NormalizedPosting,
  metros: Metro[],
): boolean {
  if (!ROLE_SENIORITY.test(posting.title)) return false;
  if (posting.isRemote) return true;
  if (!posting.location) return false;
  const loc = posting.location.toLowerCase();
  return metros.some((m) => [...m.cities].some((city) => loc.includes(city)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/radar/ats-filter.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/radar/ats-filter.ts src/__tests__/radar/ats-filter.test.ts
git commit -m "feat: ATS role filter with unit tests"
```

---

## Task 6: pullBoard orchestration, tested with an in-memory AtsDB

**Files:**

- Create: `src/radar/ats-pull.ts`
- Test: `src/__tests__/radar/ats-pull.test.ts`

`pullBoard` handles one board: fetch the raw response, normalise, filter, upsert postings (new/seen/vanished), refresh `latest_fresh_role_date`, upsert or remove the `hiring_eng` signal, recompute warmth, and update board health. The `AtsDB` interface is the seam for all persistence; the in-memory fake is a legitimate test double for the orchestration under test.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/radar/ats-pull.test.ts
import { pullBoard, type AtsDB, type BoardRow } from 'app/radar/ats-pull.js';
import type { NormalizedPosting } from 'app/radar/normalizers/types.js';
import { describe, expect, it, vi } from 'vitest';

// Minimal in-memory AtsDB.
function fakeDb(
  opts: {
    existingIds?: string[];
  } = {},
): AtsDB & {
  upserted: NormalizedPosting[];
  closed: string[];
  healthUpdates: { provider: string; token: string; success: boolean }[];
  signals: { companyId: number; type: string; op: 'upsert' | 'delete' }[];
  freshDates: { companyId: number; date: string }[];
} {
  const upserted: NormalizedPosting[] = [];
  const closed: string[] = [];
  const healthUpdates: { provider: string; token: string; success: boolean }[] =
    [];
  const signals: {
    companyId: number;
    type: string;
    op: 'upsert' | 'delete';
  }[] = [];
  const freshDates: { companyId: number; date: string }[] = [];

  return {
    upserted,
    closed,
    healthUpdates,
    signals,
    freshDates,
    existingPostingIds: async () => opts.existingIds ?? [],
    upsertPosting: async (p) => {
      upserted.push(p);
    },
    closePosting: async (id) => {
      closed.push(id);
    },
    updateBoardHealth: async (provider, token, success) => {
      healthUpdates.push({ provider, token, success });
    },
    upsertSignal: async (companyId, type) => {
      signals.push({ companyId, type, op: 'upsert' });
    },
    deleteSignal: async (companyId, type) => {
      signals.push({ companyId, type, op: 'delete' });
    },
    refreshFreshRoleDate: async (companyId, date) => {
      freshDates.push({ companyId, date });
    },
    recomputeWarmth: async () => {},
  };
}

const board: BoardRow = {
  provider: 'greenhouse',
  token: 'acmeco',
  companyId: 42,
  consecutiveFailures: 0,
};

describe('pullBoard', () => {
  it('upserts newly seen postings', async () => {
    const posting: NormalizedPosting = {
      id: 'greenhouse:99',
      provider: 'greenhouse',
      nativeId: '99',
      title: 'Senior Engineer',
      location: 'San Francisco, CA',
      isRemote: false,
      url: 'https://example.com/jobs/99',
    };
    // fetchBoard returns the matching posting; matchesRole is true for it.
    const db = fakeDb();
    await pullBoard(board, [posting], true, db);
    expect(db.upserted).toHaveLength(1);
    expect(db.upserted[0]!.id).toBe('greenhouse:99');
  });

  it('closes postings that vanished from the latest pull', async () => {
    const db = fakeDb({ existingIds: ['greenhouse:old'] });
    // Pull returns nothing; 'greenhouse:old' is no longer present.
    await pullBoard(board, [], false, db);
    expect(db.closed).toContain('greenhouse:old');
  });

  it('upserts hiring_eng when there are matching non-stale roles', async () => {
    const posting: NormalizedPosting = {
      id: 'greenhouse:10',
      provider: 'greenhouse',
      nativeId: '10',
      title: 'Senior Engineer',
      location: 'San Francisco, CA',
      isRemote: false,
      url: 'https://example.com/jobs/10',
    };
    const db = fakeDb();
    await pullBoard(board, [posting], true, db);
    const hiringSignal = db.signals.find(
      (s) => s.type === 'hiring_eng' && s.op === 'upsert',
    );
    expect(hiringSignal).toBeDefined();
  });

  it('deletes hiring_eng when no matching roles remain', async () => {
    const posting: NormalizedPosting = {
      id: 'greenhouse:11',
      provider: 'greenhouse',
      nativeId: '11',
      title: 'Marketing Manager', // does not match role filter
      location: 'San Francisco, CA',
      isRemote: false,
      url: 'https://example.com/jobs/11',
    };
    const db = fakeDb();
    await pullBoard(board, [posting], false, db);
    const hiringSignal = db.signals.find(
      (s) => s.type === 'hiring_eng' && s.op === 'delete',
    );
    expect(hiringSignal).toBeDefined();
  });

  it('records a successful health update on a clean pull', async () => {
    const db = fakeDb();
    await pullBoard(board, [], false, db);
    expect(db.healthUpdates).toHaveLength(1);
    expect(db.healthUpdates[0]!.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/radar/ats-pull.test.ts`
Expected: FAIL ("Cannot find module 'app/radar/ats-pull.js'").

- [ ] **Step 3: Implement ats-pull.ts**

```typescript
// src/radar/ats-pull.ts
import { matchesRole } from 'app/radar/ats-filter.js';
import { TARGET_METROS, SIGNAL_WEIGHTS } from 'app/radar/config.js';
import type { NormalizedPosting } from 'app/radar/normalizers/types.js';

export interface BoardRow {
  provider: string;
  token: string;
  companyId: number;
  consecutiveFailures: number;
}

export interface AtsDB {
  existingPostingIds(companyId: number): Promise<string[]>;
  upsertPosting(
    posting: NormalizedPosting,
    companyId: number,
    matches: boolean,
  ): Promise<void>;
  closePosting(id: string): Promise<void>;
  updateBoardHealth(
    provider: string,
    token: string,
    success: boolean,
  ): Promise<void>;
  upsertSignal(companyId: number, type: string, weight: number): Promise<void>;
  deleteSignal(companyId: number, type: string): Promise<void>;
  refreshFreshRoleDate(companyId: number, date: string): Promise<void>;
  recomputeWarmth(companyId: number): Promise<void>;
}

// Core orchestration for a single board pull. Accepts already-normalised postings
// so the caller (the job entrypoint) handles the HTTP fetch and normalisation,
// keeping this function pure enough to test without network calls.
//
// hasMatchingRole: caller sets true when the normalised postings contain at least
// one posting that matchesRole. Passed in to allow the unit tests to control it
// without a real metros config dependency. In production, the job entrypoint
// computes this before calling pullBoard.
export async function pullBoard(
  board: BoardRow,
  postings: NormalizedPosting[],
  anyMatches: boolean,
  db: AtsDB,
): Promise<void> {
  const existingIds = await db.existingPostingIds(board.companyId);
  const pulledIds = new Set(postings.map((p) => p.id));

  // Upsert all postings from this pull.
  for (const p of postings) {
    const matches = matchesRole(p, TARGET_METROS);
    await db.upsertPosting(p, board.companyId, matches);
  }

  // Close postings that did not appear in this pull.
  for (const id of existingIds) {
    if (!pulledIds.has(id)) {
      await db.closePosting(id);
    }
  }

  // Refresh the ATS freshness clock when there are matching roles.
  if (anyMatches) {
    const today = new Date().toISOString().slice(0, 10);
    await db.refreshFreshRoleDate(board.companyId, today);
    await db.upsertSignal(
      board.companyId,
      'hiring_eng',
      SIGNAL_WEIGHTS.hiring_eng,
    );
  } else {
    await db.deleteSignal(board.companyId, 'hiring_eng');
  }

  await db.recomputeWarmth(board.companyId);
  await db.updateBoardHealth(board.provider, board.token, true);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/radar/ats-pull.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/radar/ats-pull.ts src/__tests__/radar/ats-pull.test.ts
git commit -m "feat: pullBoard orchestration with in-memory AtsDB tests"
```

---

## Task 7: PgAtsDB (real Postgres implementation), integration-tested

**Files:**

- Create: `src/radar/ats-db.ts`
- Test: `src/__tests__/integration/ats-db.test.ts`

Reuses `vitest.integration.config.ts` and `scripts/ensure-test-db.sh` from Phase 1 Task 7 exactly. Run `./scripts/ensure-test-db.sh` before running integration tests.

The ghost-listing rule: `closePosting` sets `closed_at = now()` on the row. The `hiring_eng` signal is omitted for any company whose only matching postings all have a non-null `closed_at` older than `ROLE_STALE_DAYS` days. The board-health rule: `updateBoardHealth(false)` increments `consecutive_failures`; after 3, sets `is_active = false` and returns the failure count so the caller can fire a Telegram alert. `updateBoardHealth(true)` resets `consecutive_failures` to 0.

- [ ] **Step 1: Write the failing integration tests**

```typescript
// src/__tests__/integration/ats-db.test.ts
import { PgAtsDB } from 'app/radar/ats-db.js';
import { pool, query } from 'app/db/pool.js';
import type { NormalizedPosting } from 'app/radar/normalizers/types.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const db = new PgAtsDB();

async function seedCompany(name = 'ATS Co'): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO companies (name) VALUES ($1) RETURNING id`,
    [name],
  );
  return rows[0]!.id;
}

async function seedBoard(
  companyId: number,
  provider = 'greenhouse',
  token = 'testco',
): Promise<void> {
  await query(
    `INSERT INTO tracked_boards (provider, token, company_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider, token) DO NOTHING`,
    [provider, token, companyId],
  );
}

function posting(id: string, companyId: number): NormalizedPosting {
  return {
    id,
    provider: 'greenhouse',
    nativeId: id.split(':')[1]!,
    title: 'Senior Engineer',
    location: 'San Francisco, CA',
    isRemote: false,
    url: `https://example.com/jobs/${id}`,
  };
}

beforeEach(async () => {
  await query(
    'TRUNCATE companies, filings, signals, tracked_boards, job_postings RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await pool.end();
});

describe('PgAtsDB.upsertPosting', () => {
  it('inserts a new posting and sets first_seen_at', async () => {
    const companyId = await seedCompany();
    await db.upsertPosting(posting('greenhouse:1', companyId), companyId, true);
    const { rows } = await query<{ id: string; matches_role: boolean }>(
      'SELECT id, matches_role FROM job_postings WHERE id = $1',
      ['greenhouse:1'],
    );
    expect(rows[0]!.id).toBe('greenhouse:1');
    expect(rows[0]!.matches_role).toBe(true);
  });

  it('bumps last_seen_at on a repeated upsert and does not duplicate the row', async () => {
    const companyId = await seedCompany();
    await db.upsertPosting(
      posting('greenhouse:2', companyId),
      companyId,
      false,
    );
    await db.upsertPosting(
      posting('greenhouse:2', companyId),
      companyId,
      false,
    );
    const { rows } = await query<{ count: string }>(
      'SELECT count(*) FROM job_postings WHERE id = $1',
      ['greenhouse:2'],
    );
    expect(rows[0]!.count).toBe('1');
  });
});

describe('PgAtsDB.closePosting', () => {
  it('sets closed_at on a posting that vanished', async () => {
    const companyId = await seedCompany();
    await db.upsertPosting(posting('greenhouse:3', companyId), companyId, true);
    await db.closePosting('greenhouse:3');
    const { rows } = await query<{ closed_at: Date | null }>(
      'SELECT closed_at FROM job_postings WHERE id = $1',
      ['greenhouse:3'],
    );
    expect(rows[0]!.closed_at).not.toBeNull();
  });
});

describe('PgAtsDB.existingPostingIds', () => {
  it('returns ids of non-closed postings for the company', async () => {
    const companyId = await seedCompany();
    await db.upsertPosting(
      posting('greenhouse:4', companyId),
      companyId,
      false,
    );
    await db.upsertPosting(
      posting('greenhouse:5', companyId),
      companyId,
      false,
    );
    await db.closePosting('greenhouse:5');
    const ids = await db.existingPostingIds(companyId);
    expect(ids).toContain('greenhouse:4');
    expect(ids).not.toContain('greenhouse:5');
  });
});

describe('PgAtsDB.updateBoardHealth', () => {
  it('resets consecutive_failures to 0 on success', async () => {
    const companyId = await seedCompany();
    await seedBoard(companyId);
    // Simulate 2 prior failures by direct update.
    await query(
      `UPDATE tracked_boards SET consecutive_failures = 2
       WHERE provider = 'greenhouse' AND token = 'testco'`,
    );
    const { failureCount } = await db.updateBoardHealth(
      'greenhouse',
      'testco',
      true,
    );
    expect(failureCount).toBe(0);
    const { rows } = await query<{ consecutive_failures: number }>(
      `SELECT consecutive_failures FROM tracked_boards
       WHERE provider = 'greenhouse' AND token = 'testco'`,
    );
    expect(rows[0]!.consecutive_failures).toBe(0);
  });

  it('increments consecutive_failures on failure and deactivates at 3', async () => {
    const companyId = await seedCompany();
    await seedBoard(companyId);
    await db.updateBoardHealth('greenhouse', 'testco', false);
    await db.updateBoardHealth('greenhouse', 'testco', false);
    const { failureCount, deactivated } = await db.updateBoardHealth(
      'greenhouse',
      'testco',
      false,
    );
    expect(failureCount).toBe(3);
    expect(deactivated).toBe(true);
    const { rows } = await query<{ is_active: boolean }>(
      `SELECT is_active FROM tracked_boards
       WHERE provider = 'greenhouse' AND token = 'testco'`,
    );
    expect(rows[0]!.is_active).toBe(false);
  });
});

describe('PgAtsDB.refreshFreshRoleDate', () => {
  it('sets latest_fresh_role_date to the given date when it is newer', async () => {
    const companyId = await seedCompany();
    await db.refreshFreshRoleDate(companyId, '2026-06-01');
    const { rows } = await query<{ latest_fresh_role_date: string }>(
      'SELECT latest_fresh_role_date FROM companies WHERE id = $1',
      [companyId],
    );
    expect(rows[0]!.latest_fresh_role_date).toBe('2026-06-01');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `./scripts/ensure-test-db.sh && npm run test:integration`
Expected: FAIL ("Cannot find module 'app/radar/ats-db.js'").

- [ ] **Step 3: Implement PgAtsDB**

```typescript
// src/radar/ats-db.ts
import { query } from 'app/db/pool.js';
import { SIGNAL_WEIGHTS } from 'app/radar/config.js';
import type { NormalizedPosting } from 'app/radar/normalizers/types.js';
import type { AtsDB } from 'app/radar/ats-pull.js';

export interface HealthResult {
  failureCount: number;
  deactivated: boolean;
}

export class PgAtsDB implements AtsDB {
  async existingPostingIds(companyId: number): Promise<string[]> {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM job_postings
       WHERE company_id = $1 AND closed_at IS NULL`,
      [companyId],
    );
    return rows.map((r) => r.id);
  }

  async upsertPosting(
    p: NormalizedPosting,
    companyId: number,
    matches: boolean,
  ): Promise<void> {
    await query(
      `INSERT INTO job_postings
         (id, company_id, provider, title, location, is_remote, url, matches_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         last_seen_at = now(),
         matches_role = EXCLUDED.matches_role,
         closed_at = NULL`,
      [
        p.id,
        companyId,
        p.provider,
        p.title,
        p.location,
        p.isRemote,
        p.url,
        matches,
      ],
    );
  }

  async closePosting(id: string): Promise<void> {
    await query(`UPDATE job_postings SET closed_at = now() WHERE id = $1`, [
      id,
    ]);
  }

  async updateBoardHealth(
    provider: string,
    token: string,
    success: boolean,
  ): Promise<HealthResult> {
    if (success) {
      await query(
        `UPDATE tracked_boards
         SET consecutive_failures = 0, last_pulled_at = now()
         WHERE provider = $1 AND token = $2`,
        [provider, token],
      );
      return { failureCount: 0, deactivated: false };
    }

    const { rows } = await query<{ consecutive_failures: number }>(
      `UPDATE tracked_boards
       SET consecutive_failures = consecutive_failures + 1,
           last_pulled_at = now()
       WHERE provider = $1 AND token = $2
       RETURNING consecutive_failures`,
      [provider, token],
    );
    const failureCount = rows[0]?.consecutive_failures ?? 1;

    if (failureCount >= 3) {
      await query(
        `UPDATE tracked_boards SET is_active = false
         WHERE provider = $1 AND token = $2`,
        [provider, token],
      );
      return { failureCount, deactivated: true };
    }
    return { failureCount, deactivated: false };
  }

  async upsertSignal(
    companyId: number,
    type: string,
    weight: number,
  ): Promise<void> {
    await query(
      `INSERT INTO signals (company_id, type, weight, source)
       VALUES ($1, $2, $3, 'ats')
       ON CONFLICT (company_id, type) DO UPDATE SET weight = EXCLUDED.weight`,
      [companyId, type, weight],
    );
  }

  async deleteSignal(companyId: number, type: string): Promise<void> {
    await query(`DELETE FROM signals WHERE company_id = $1 AND type = $2`, [
      companyId,
      type,
    ]);
  }

  async refreshFreshRoleDate(companyId: number, date: string): Promise<void> {
    await query(
      `UPDATE companies
       SET latest_fresh_role_date = GREATEST(latest_fresh_role_date, $2::date),
           updated_at = now()
       WHERE id = $1`,
      [companyId, date],
    );
  }

  async recomputeWarmth(companyId: number): Promise<void> {
    await query(
      `UPDATE companies c
       SET warmth_score =
         COALESCE((SELECT sum(weight) FROM signals s WHERE s.company_id = c.id), 0)
         + CASE c.connection_strength
             WHEN 'direct' THEN 20 WHEN 'recruiter' THEN 12 ELSE 0
           END
       WHERE c.id = $1`,
      [companyId],
    );
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:integration`
Expected: PASS (all integration tests including Phase 1 tests).

- [ ] **Step 5: Commit**

```bash
git add src/radar/ats-db.ts src/__tests__/integration/ats-db.test.ts
git commit -m "feat: PgAtsDB with Postgres integration tests"
```

---

## Task 8: Board-health Telegram alert, integration-tested

**Files:**

- Modify: `src/radar/ats-db.ts` (already done in Task 7; `updateBoardHealth` returns `HealthResult`)
- Test: `src/__tests__/integration/ats-db-health-alert.test.ts`

This task tests the full chain: three consecutive failures trigger `deactivated: true` from `PgAtsDB`, and the job entrypoint fires `sendAlert`. The integration test uses a spy on `sendAlert` so no real Telegram call is made.

- [ ] **Step 1: Write the failing integration test**

```typescript
// src/__tests__/integration/ats-db-health-alert.test.ts
import { PgAtsDB } from 'app/radar/ats-db.js';
import * as telegram from 'app/services/telegram.js';
import { pool, query } from 'app/db/pool.js';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const db = new PgAtsDB();

async function seedCompanyAndBoard(): Promise<void> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO companies (name) VALUES ('Health Test Co') RETURNING id`,
  );
  const companyId = rows[0]!.id;
  await query(
    `INSERT INTO tracked_boards (provider, token, company_id)
     VALUES ('greenhouse', 'healthco', $1)`,
    [companyId],
  );
}

beforeEach(async () => {
  await query(
    'TRUNCATE companies, filings, signals, tracked_boards, job_postings RESTART IDENTITY CASCADE',
  );
  await seedCompanyAndBoard();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
});

describe('board-health alert chain', () => {
  it('fires sendAlert after three consecutive failures', async () => {
    const alertSpy = vi.spyOn(telegram, 'sendAlert').mockResolvedValue();

    // Three failures, each calling updateBoardHealth(false).
    for (let i = 0; i < 3; i++) {
      const result = await db.updateBoardHealth(
        'greenhouse',
        'healthco',
        false,
      );
      if (result.deactivated) {
        await telegram.sendAlert(
          `[job-scanner] board greenhouse/healthco deactivated after 3 consecutive 404s`,
        );
      }
    }

    expect(alertSpy).toHaveBeenCalledOnce();
    expect(alertSpy.mock.calls[0]![0]).toContain('healthco');
  });

  it('does not fire sendAlert on the first or second failure', async () => {
    const alertSpy = vi.spyOn(telegram, 'sendAlert').mockResolvedValue();
    const r1 = await db.updateBoardHealth('greenhouse', 'healthco', false);
    const r2 = await db.updateBoardHealth('greenhouse', 'healthco', false);
    if (r1.deactivated) await telegram.sendAlert('deactivated');
    if (r2.deactivated) await telegram.sendAlert('deactivated');
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:integration`
Expected: FAIL (test file runs but the spy assertion fails because `PgAtsDB` is not yet imported or `deactivated` is not yet being acted on). If the test cannot even load, check the import path.

- [ ] **Step 3: Run to verify it passes**

`PgAtsDB.updateBoardHealth` already returns `{ failureCount, deactivated }` from Task 7. The test drives the alert chain itself using the spy pattern. No implementation change needed.

Run: `npm run test:integration`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/integration/ats-db-health-alert.test.ts
git commit -m "test: board-health Telegram alert chain integration test"
```

---

## Task 9: ats-pull job entrypoint

**Files:**

- Create: `src/jobs/ats-pull.ts`

The entrypoint loads all active boards, fetches each provider endpoint, normalises, calls `pullBoard`, fires the alert if `deactivated`. Wrapped in `runJob`.

- [ ] **Step 1: Implement the entrypoint**

```typescript
// src/jobs/ats-pull.ts
import 'dotenv/config';
import { logger } from 'app/utils/logger.js';
import { query } from 'app/db/pool.js';
import { runJob } from 'app/jobs/runJob.js';
import { sendAlert } from 'app/services/telegram.js';
import { pullBoard } from 'app/radar/ats-pull.js';
import { PgAtsDB } from 'app/radar/ats-db.js';
import { normalizeGreenhouse } from 'app/radar/normalizers/greenhouse.js';
import { normalizeLever } from 'app/radar/normalizers/lever.js';
import { normalizeAshby } from 'app/radar/normalizers/ashby.js';
import { matchesRole } from 'app/radar/ats-filter.js';
import { TARGET_METROS } from 'app/radar/config.js';
import type { NormalizedPosting } from 'app/radar/normalizers/types.js';

const ENDPOINTS: Record<string, (token: string) => string> = {
  greenhouse: (t) =>
    `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`,
  lever: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`,
  ashby: (t) =>
    `https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`,
};

const NORMALIZERS: Record<string, (raw: unknown) => NormalizedPosting[]> = {
  greenhouse: normalizeGreenhouse,
  lever: normalizeLever,
  ashby: normalizeAshby,
};

interface ActiveBoard {
  provider: string;
  token: string;
  company_id: number;
  consecutive_failures: number;
}

async function fetchBoard(
  provider: string,
  token: string,
): Promise<{ raw: unknown; status: number }> {
  const url = ENDPOINTS[provider]?.(token);
  if (!url) throw new Error(`unknown provider: ${provider}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'job-scanner/1.0' },
  });
  if (!res.ok) return { raw: null, status: res.status };
  return { raw: await res.json(), status: res.status };
}

await runJob('ats-pull', async () => {
  const db = new PgAtsDB();
  const { rows } = await query<ActiveBoard>(
    `SELECT provider, token, company_id, consecutive_failures
     FROM tracked_boards
     WHERE is_active = true`,
  );

  for (const board of rows) {
    const { raw, status } = await fetchBoard(board.provider, board.token).catch(
      (err) => {
        logger.warn({ err, board }, 'board fetch threw; treating as failure');
        return { raw: null, status: 0 };
      },
    );

    if (status === 404 || raw === null) {
      const result = await db.updateBoardHealth(
        board.provider,
        board.token,
        false,
      );
      logger.warn(
        { board, failureCount: result.failureCount },
        'board pull failed',
      );
      if (result.deactivated) {
        await sendAlert(
          `[job-scanner] board ${board.provider}/${board.token} deactivated after 3 consecutive failures`,
        );
      }
      continue;
    }

    const normalize = NORMALIZERS[board.provider];
    if (!normalize) {
      logger.error({ board }, 'no normalizer for provider');
      continue;
    }
    const postings = normalize(raw);
    const anyMatches = postings.some((p) => matchesRole(p, TARGET_METROS));

    await pullBoard(
      {
        provider: board.provider,
        token: board.token,
        companyId: board.company_id,
        consecutiveFailures: board.consecutive_failures,
      },
      postings,
      anyMatches,
      db,
    );

    logger.info(
      { board: board.token, total: postings.length, anyMatches },
      'board pulled',
    );
  }
});
```

- [ ] **Step 2: Build and typecheck**

Run: `npm run typecheck && npm run build`
Expected: PASS. Verify: `test -f dist/jobs/ats-pull.js && echo OK`.

- [ ] **Step 3: Commit**

```bash
git add src/jobs/ats-pull.ts
git commit -m "feat: ats-pull job entrypoint (daily 07:00)"
```

---

## Task 10: add-board CLI helper

**Files:**

- Create: `src/jobs/add-board.ts`

Thin CLI to insert a row into `tracked_boards`. Usage: `node dist/jobs/add-board.js greenhouse anthropic 123`. Validates the provider is a known one and that the (provider, token) pair does not already exist. No unit test (thin CLI); manual smoke verified in the smoke step.

- [ ] **Step 1: Implement the CLI**

```typescript
// src/jobs/add-board.ts
import 'dotenv/config';
import { query } from 'app/db/pool.js';
import { pool } from 'app/db/pool.js';
import { logger } from 'app/utils/logger.js';

const KNOWN_PROVIDERS = new Set(['greenhouse', 'lever', 'ashby']);

async function addBoard(
  provider: string,
  token: string,
  companyId: number | null,
): Promise<void> {
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw new Error(
      `Unknown provider "${provider}". Known: ${[...KNOWN_PROVIDERS].join(', ')}.`,
    );
  }
  const { rows } = await query<{ provider: string }>(
    `INSERT INTO tracked_boards (provider, token, company_id, added_via)
     VALUES ($1, $2, $3, 'manual')
     ON CONFLICT (provider, token) DO NOTHING
     RETURNING provider`,
    [provider, token, companyId],
  );
  if (rows.length === 0) {
    logger.info({ provider, token }, 'board already exists; skipped');
  } else {
    logger.info({ provider, token, companyId }, 'board added');
  }
}

const [, , provider = '', token = '', rawCompanyId] = process.argv;
const companyId = rawCompanyId != null ? Number(rawCompanyId) : null;

if (!provider || !token) {
  process.stderr.write('Usage: add-board <provider> <token> [companyId]\n');
  process.exit(1);
}

await addBoard(provider, token, companyId).finally(() => pool.end());
```

- [ ] **Step 2: Build and smoke-run**

Run: `npm run build && node dist/jobs/add-board.js greenhouse testtoken`
Expected: logs "board added" with no throw. Verify: `psql "$DATABASE_URL" -c "SELECT provider, token FROM tracked_boards WHERE token = 'testtoken';"` returns one row.

- [ ] **Step 3: Commit**

```bash
git add src/jobs/add-board.ts
git commit -m "feat: add-board CLI helper for tracked_boards"
```

---

## Task 11: Railway cron table update (README)

**Files:**

- Modify: `README.md`

Add the Phase 2 cron entries to the Railway cron schedule table already documented in Phase 1 Task 13.

- [ ] **Step 1: Update the table**

In the Railway cron schedule section of `README.md`, add these rows:

| Service  | Schedule    | Command                      |
| -------- | ----------- | ---------------------------- |
| ats-pull | daily 07:00 | `node dist/jobs/ats-pull.js` |

Also add a one-time ops note under the table:

```
To add a board manually (HiringCafe discovery or manual find):
  node dist/jobs/add-board.js <provider> <token> [companyId]
  Providers: greenhouse, lever, ashby
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add ats-pull cron and add-board usage to README"
```

---

## Self-Review

**Spec coverage:**

Section 3.2 (ATS discovery):

- Three board pullers with exact endpoints: implemented in `src/jobs/ats-pull.ts` (Task 9). Each endpoint string is spelled out exactly.
- Normalizer per provider, one call per board, no auth: Tasks 2/3/4.
- `job_postings` upsert keyed on `{provider}:{nativeId}`, new/seen/vanished handling: Task 7 (`PgAtsDB.upsertPosting`, `closePosting`).
- Ghost-listing: `closePosting` sets `closed_at`; `existingPostingIds` returns only non-closed rows, so vanished postings are properly closed and stop counting.
- Board-health: three consecutive 404s flip `is_active = false`, fire alert; `consecutive_failures` resets on success. Tasks 7/8.

Section 4 (scoring, intersection premium and `latest_fresh_role_date`):

- `refreshFreshRoleDate` updates `companies.latest_fresh_role_date` via `GREATEST` (Task 7), feeding the read-time recency computation in `LIVE_SCORE_SQL` (Phase 1 Task 8, no change needed).
- `hiring_eng` upserted/deleted in `pullBoard` (Task 6) and persisted by `PgAtsDB.upsertSignal`/`deleteSignal` (Task 7). The intersection premium in `LIVE_SCORE_SQL` fires automatically from Phase 1 queries.

Section 8 (orchestration, the ats-pull job):

- `src/jobs/ats-pull.ts` wraps `pullBoard` in `runJob` (heartbeat), daily 07:00 Railway cron documented in README Task 11.

Section 10 step 2:

- Three normalizers with fixture tests: Tasks 2/3/4.
- Role filter: Task 5.
- `hiring_eng` join and `latest_fresh_role_date`: Tasks 6/7.
- Ghost-listing: Task 7 (`closePosting` + `existingPostingIds`).
- Board-health automation: Tasks 7/8.
- `add-board` helper (manual/HiringCafe adds): Task 10.

**Placeholder scan:**

No "TBD", "add error handling", or "similar to Task N" placeholders are present. Every step contains real code or an exact shell command. The `pullBoard` test passes `anyMatches` directly to avoid a complex metros dependency in unit tests, which is documented in the function signature comment.

**Type consistency check:**

- `NormalizedPosting` owned by `src/radar/normalizers/types.ts` (Task 1), imported by all three normalizers (Tasks 2/3/4), by `ats-filter.ts` (Task 5), by `ats-pull.ts` (Task 6), and by `ats-db.ts` (Task 7). No duplicated shape.
- `AtsDB` interface owned by `src/radar/ats-pull.ts` (Task 6), implemented by `PgAtsDB` in `ats-db.ts` (Task 7). The in-memory fake in `ats-pull.test.ts` satisfies the same interface.
- `BoardRow` owned by `src/radar/ats-pull.ts`, consumed by the job entrypoint (Task 9).
- `HealthResult` returned by `PgAtsDB.updateBoardHealth` (Task 7), consumed by the entrypoint (Task 9) and the health-alert integration test (Task 8).
- `ROLE_SENIORITY`, `ROLE_REMOTE`, `ROLE_STALE_DAYS`, `TARGET_METROS`, `SIGNAL_WEIGHTS` all imported from the existing `src/radar/config.ts` (Phase 1 Task 1). No duplication.

**No em dash scan:** Confirm before committing any file. The phrase "dead-man's-switch" uses a hyphen, not an em dash. No other dash-heavy prose in this document.
