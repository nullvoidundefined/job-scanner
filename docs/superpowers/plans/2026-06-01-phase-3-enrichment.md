# Phase 3: Enrichment and Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layer Haiku AI-native classification (via Anthropic Batch API), YC batch cross-referencing, a classifier eval harness, the hot-alert push, and drafted outreach angles into the working radar built in Phase 1. Every enrichment gate-passer gets an `ai_native_tag`, the top scorers get a Telegram push when they cross the hot threshold, and the weekly digest gains one-line outreach angles per company.

**Architecture:** Pure logic (prompt builder, response parser, YC matcher, angle drafter) is isolated from IO (Anthropic client, Postgres). The Anthropic client submits batch requests and polls for results; it is excluded from unit coverage exactly like `telegram.ts` and `email.ts`. `enrich.ts` orchestrates: select gate-passers lacking a tag, batch-classify, persist, emit signals, recompute warmth. `hot-alert.ts` checks hourly for new companies crossing the threshold and alerts once via `sendAlert`. Both wrap in `runJob`. The `RadarDB` interface (defined in `ingest.ts`) is extended with three new methods; `PgRadarDB` implements them.

**Tech Stack:** Anthropic TypeScript SDK (`@anthropic-ai/sdk`), Haiku 4.5 (`claude-haiku-4-5-20251001`), Zod for response parsing, existing `pg`, Vitest, Resend, Telegram. Migration `0002_hot_alert.js` adds `companies.hot_alerted_at`.

**Conventions (apply to every task):**

- No em dash (U+2014) anywhere, including comments and test fixtures. Rule R-001.
- Prettier: 2-space, 80-width, single-quote, trailing commas. Imports use the `app/*` alias and `.js` extensions (NodeNext), e.g. `import { query } from 'app/db/pool.js'`.
- Pure modules (`classify.ts`, `yc-matcher.ts`, `digest.ts` angle helper) must NOT import `app/config/env.js`, so their tests need no env.
- Commit after each task. Pre-commit formats staged files; pre-push runs typecheck + test + build.

---

## File Structure

```
migrations/
  0002_hot_alert.js        Add companies.hot_alerted_at timestamptz.

src/radar/
  config.ts                Add HOT_THRESHOLD constant (no other changes).
  classify.ts              buildClassifyPrompt (pure) + parseClassifyResponse (pure, zod).
  yc-matcher.ts            matchesYcBatch (pure). Reads a checked-in fixture set.
  digest.ts                Extend buildDigestHtml to accept angles; add draftAngle (pure).
  ingest.ts                Extend RadarDB with enrichment methods.
  db.ts                    PgRadarDB: implement the three new RadarDB enrichment methods.

src/services/
  anthropic.ts             submitClassifyBatch + pollBatchResults. IO; no unit coverage.

src/jobs/
  enrich.ts                Daily 08:00 entrypoint: classify new gate-passers, persist, signal.
  hot-alert.ts             Hourly entrypoint: push companies above HOT_THRESHOLD once each.
  weekly-digest.ts         Extend to pass drafted angles into buildDigestHtml.

src/__tests__/
  fixtures/ai-native/
    labels.json            Labeled set: array of { name, description, expectedTag }.
    batch-response.json    Captured real Anthropic batch results object.
  fixtures/yc/
    yc-companies.json      Checked-in YC company name set (source: ycombinator.com/companies).
  radar/
    classify.test.ts       Unit: buildClassifyPrompt, parseClassifyResponse (fixture test).
    yc-matcher.test.ts     Unit: matchesYcBatch.
    digest.test.ts         Extend existing; add draftAngle unit tests.
  integration/
    enrich.test.ts         PgRadarDB enrichment methods + enrich orchestration.
    hot-alert.test.ts      Hot-alert threshold + single-fire logic.

scripts/
  eval-classifier.ts       Offline eval: labels.json x captured outputs -> accuracy report.
```

---

## Task 1: Install Anthropic SDK and add HOT_THRESHOLD config

**Files:**

- Modify: `package.json` (add `@anthropic-ai/sdk`)
- Modify: `src/radar/config.ts` (add `HOT_THRESHOLD`)

No new source files; no tests (config constant + package install).

- [ ] **Step 1: Install the SDK**

Run:

```bash
npm install @anthropic-ai/sdk@^0.53.0
```

Expected: package-lock.json updated, `node_modules/@anthropic-ai/sdk` present.

- [ ] **Step 2: Add HOT_THRESHOLD to config**

Open `src/radar/config.ts`. Append at the bottom (before any closing brace if the file has one):

```typescript
// Minimum live_score for a company to trigger a hot-alert push.
// Derived from the scoring table: a direct connection (20) + hiring_eng (10)
// + ai_native (8) + recency-7d (10) = 48. Set just below to catch near-matches.
export const HOT_THRESHOLD = 45;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/radar/config.ts
git commit -m "feat: install anthropic sdk and add HOT_THRESHOLD config"
```

---

## Task 2: Migration 0002 - add hot_alerted_at column

**Files:**

- Create: `migrations/0002_hot_alert.js`

- [ ] **Step 1: Write the migration**

```javascript
// migrations/0002_hot_alert.js
// Adds companies.hot_alerted_at so the hourly hot-alert job can track which
// companies have already received a push, firing each alert exactly once.

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.sql(`
    alter table companies
      add column hot_alerted_at timestamptz;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.sql(`
    alter table companies
      drop column if exists hot_alerted_at;
  `);
};
```

- [ ] **Step 2: Apply and verify**

Run:

```bash
npm run migrate:up
psql "$DATABASE_URL" -c "\d companies" | grep hot_alerted_at
```

Expected: one line showing `hot_alerted_at | timestamp with time zone`.

- [ ] **Step 3: Commit**

```bash
git add migrations/0002_hot_alert.js
git commit -m "feat: add companies.hot_alerted_at for hot-alert idempotency"
```

---

## Task 3: Pure classifier (prompt builder + response parser), test-first

**Files:**

- Create: `src/radar/classify.ts`
- Create: `src/__tests__/fixtures/ai-native/batch-response.json`
- Create: `src/__tests__/fixtures/ai-native/labels.json`
- Test: `src/__tests__/radar/classify.test.ts`

The prompt builder and response parser are pure functions. The parser is also the LLM-consumer fixture test required by project rules: it runs against a real captured Anthropic batch result, not a mocked SDK call.

- [ ] **Step 1: Capture a real batch response fixture**

Run a one-shot classification against the Anthropic Batch API (requires `ANTHROPIC_API_KEY` in `.env`) and save the raw result object. Use the Node REPL or a scratch script:

```typescript
// scratch/capture-batch-fixture.ts (delete after use)
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'node:fs';

const client = new Anthropic();
const batch = await client.messages.batches.create({
  requests: [
    {
      custom_id: 'fixture-yes',
      params: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content:
              'Company: Cohere\nDescription: Large language model API for enterprise search and generation.\n\nReturn strict JSON only: {"tag":"yes"|"maybe"|"no","reason":"<= 12 words"}',
          },
        ],
      },
    },
    {
      custom_id: 'fixture-no',
      params: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content:
              'Company: FreshDirect\nDescription: Online grocery delivery service.\n\nReturn strict JSON only: {"tag":"yes"|"maybe"|"no","reason":"<= 12 words"}',
          },
        ],
      },
    },
  ],
});

// Poll until complete (may take 1-5 minutes for Batch API).
let results;
while (true) {
  const status = await client.messages.batches.retrieve(batch.id);
  if (status.processing_status === 'ended') {
    results = [];
    for await (const r of client.messages.batches.results(batch.id)) {
      results.push(r);
    }
    break;
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
writeFileSync(
  'src/__tests__/fixtures/ai-native/batch-response.json',
  JSON.stringify(results, null, 2),
);
console.log('saved');
```

Run: `npx tsx scratch/capture-batch-fixture.ts`
Expected: `src/__tests__/fixtures/ai-native/batch-response.json` saved with two result objects. Delete the scratch script after.

- [ ] **Step 2: Create the labels fixture**

Create `src/__tests__/fixtures/ai-native/labels.json` with a minimum of 10 labeled examples spanning all three tags. These are the oracle for the eval harness (Task 9). Format:

```json
[
  {
    "name": "Cohere",
    "description": "Large language model API for enterprise search and generation.",
    "expectedTag": "yes"
  },
  {
    "name": "Scale AI",
    "description": "Data labeling and AI infrastructure platform.",
    "expectedTag": "yes"
  },
  {
    "name": "Weights and Biases",
    "description": "ML experiment tracking and model management platform.",
    "expectedTag": "yes"
  },
  {
    "name": "Harvey",
    "description": "AI legal research and drafting assistant for law firms.",
    "expectedTag": "maybe"
  },
  {
    "name": "Abridge",
    "description": "AI-powered clinical note generation from doctor-patient conversations.",
    "expectedTag": "maybe"
  },
  {
    "name": "Glean",
    "description": "Enterprise search and knowledge discovery powered by AI.",
    "expectedTag": "maybe"
  },
  {
    "name": "FreshDirect",
    "description": "Online grocery delivery service.",
    "expectedTag": "no"
  },
  {
    "name": "Faire",
    "description": "B2B wholesale marketplace connecting brands and retailers.",
    "expectedTag": "no"
  },
  {
    "name": "Navan",
    "description": "Corporate travel and expense management platform.",
    "expectedTag": "no"
  },
  {
    "name": "Ro",
    "description": "Direct-to-consumer telehealth and pharmacy platform.",
    "expectedTag": "no"
  }
]
```

- [ ] **Step 3: Write the failing tests**

```typescript
// src/__tests__/radar/classify.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildClassifyPrompt,
  parseClassifyResponse,
} from 'app/radar/classify.js';
import { describe, expect, it } from 'vitest';

function fixture(name: string): string {
  const url = new URL(`../fixtures/ai-native/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}

describe('buildClassifyPrompt', () => {
  it('returns a non-empty string containing the company name', () => {
    const prompt = buildClassifyPrompt('Cohere', 'LLM APIs for enterprise.');
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('Cohere');
  });

  it('contains the required output format instruction', () => {
    const prompt = buildClassifyPrompt('Acme', 'Widget maker.');
    expect(prompt).toContain('"tag"');
    expect(prompt).toContain('"reason"');
    expect(prompt).toContain('yes');
    expect(prompt).toContain('maybe');
    expect(prompt).toContain('no');
  });

  it('is a pure function: same inputs produce the same output', () => {
    const a = buildClassifyPrompt('Acme', 'Widget maker.');
    const b = buildClassifyPrompt('Acme', 'Widget maker.');
    expect(a).toBe(b);
  });

  it('handles a missing description without throwing', () => {
    expect(() => buildClassifyPrompt('Acme', '')).not.toThrow();
  });
});

describe('parseClassifyResponse', () => {
  it('parses a valid yes response', () => {
    const result = parseClassifyResponse(
      '{"tag":"yes","reason":"AI is the core product"}',
    );
    expect(result.tag).toBe('yes');
    expect(result.reason).toBe('AI is the core product');
  });

  it('parses a valid maybe response', () => {
    const result = parseClassifyResponse(
      '{"tag":"maybe","reason":"applied to legal vertical"}',
    );
    expect(result.tag).toBe('maybe');
  });

  it('parses a valid no response', () => {
    const result = parseClassifyResponse(
      '{"tag":"no","reason":"grocery delivery"}',
    );
    expect(result.tag).toBe('no');
  });

  it('defaults to maybe and logs on a malformed response', () => {
    const result = parseClassifyResponse('not json at all');
    expect(result.tag).toBe('maybe');
    expect(typeof result.reason).toBe('string');
  });

  it('defaults to maybe when tag is not a valid enum value', () => {
    const result = parseClassifyResponse(
      '{"tag":"unknown","reason":"something"}',
    );
    expect(result.tag).toBe('maybe');
  });

  it('truncates a reason over 12 words to the first 12 words', () => {
    const longReason =
      'one two three four five six seven eight nine ten eleven twelve extra';
    const result = parseClassifyResponse(
      JSON.stringify({ tag: 'yes', reason: longReason }),
    );
    const wordCount = result.reason.split(/\s+/).length;
    expect(wordCount).toBeLessThanOrEqual(12);
  });

  // LLM-consumer fixture test: run the parser against a real captured Anthropic
  // batch response to assert the parser extracts tag and reason correctly.
  it('extracts tag and reason from a real captured Anthropic batch result', () => {
    const raw = fixture('batch-response.json');
    const results = JSON.parse(raw) as Array<{
      custom_id: string;
      result: {
        type: string;
        message: { content: Array<{ type: string; text: string }> };
      };
    }>;

    const yesResult = results.find((r) => r.custom_id === 'fixture-yes');
    expect(yesResult).toBeDefined();
    const yesText = yesResult!.result.message.content.find(
      (c) => c.type === 'text',
    )!.text;
    const parsed = parseClassifyResponse(yesText);
    expect(['yes', 'maybe', 'no']).toContain(parsed.tag);
    expect(typeof parsed.reason).toBe('string');
    expect(parsed.reason.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/radar/classify.test.ts`
Expected: FAIL with "Cannot find module 'app/radar/classify.js'".

- [ ] **Step 5: Implement classify.ts**

```typescript
// src/radar/classify.ts
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AiNativeTag = 'yes' | 'maybe' | 'no';

export interface ClassifyResult {
  tag: AiNativeTag;
  reason: string;
}

// ---------------------------------------------------------------------------
// Pure: prompt builder
// ---------------------------------------------------------------------------

// Returns the user-turn prompt for a single company classification request.
// Pure: no imports from app/config/env.js, no IO.
export function buildClassifyPrompt(
  companyName: string,
  description: string,
): string {
  return `Classify whether AI or ML is central to the following company's product.

Company: ${companyName}
Description: ${description || '(no description provided)'}

Definitions:
- "yes": AI or ML is the core product (e.g. an LLM API, a model training platform, an AI agent framework).
- "maybe": AI or ML is applied to a vertical but is not the primary value proposition (e.g. AI legal research, AI note-taking, AI-powered search).
- "no": AI or ML is incidental or absent (e.g. a marketplace, a SaaS workflow tool, a delivery service).

Return strict JSON only, no prose, no markdown:
{"tag":"yes"|"maybe"|"no","reason":"<= 12 words explaining the classification"}`;
}

// ---------------------------------------------------------------------------
// Zod schema for the model response
// ---------------------------------------------------------------------------

const classifySchema = z.object({
  tag: z.enum(['yes', 'maybe', 'no']),
  reason: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Pure: response parser
// ---------------------------------------------------------------------------

// Parses and validates the model's JSON response. On any parse or validation
// failure, defaults to tag "maybe" and logs the issue. Never throws.
export function parseClassifyResponse(raw: string): ClassifyResult {
  try {
    const json = JSON.parse(raw.trim()) as unknown;
    const parsed = classifySchema.safeParse(json);
    if (!parsed.success) {
      console.warn(
        '[classify] invalid schema; defaulting to maybe:',
        parsed.error.message,
        '| raw:',
        raw.slice(0, 200),
      );
      return { tag: 'maybe', reason: 'parse error; defaulted' };
    }
    const words = parsed.data.reason.trim().split(/\s+/);
    const reason =
      words.length > 12 ? words.slice(0, 12).join(' ') : parsed.data.reason;
    return { tag: parsed.data.tag, reason };
  } catch {
    console.warn(
      '[classify] JSON.parse failed; defaulting to maybe | raw:',
      raw.slice(0, 200),
    );
    return { tag: 'maybe', reason: 'json parse error; defaulted' };
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/radar/classify.test.ts`
Expected: PASS (8 tests, including the fixture test).

- [ ] **Step 7: Commit**

```bash
git add src/radar/classify.ts \
  src/__tests__/radar/classify.test.ts \
  src/__tests__/fixtures/ai-native/batch-response.json \
  src/__tests__/fixtures/ai-native/labels.json
git commit -m "feat: pure classifier prompt builder and zod parser with fixture test"
```

---

## Task 4: YC batch matcher, test-first

**Files:**

- Create: `src/radar/yc-matcher.ts`
- Create: `src/__tests__/fixtures/yc/yc-companies.json`
- Test: `src/__tests__/radar/yc-matcher.test.ts`

The YC company set is a checked-in fixture (source: https://www.ycombinator.com/companies, exported as JSON). The matcher is pure: normalized name comparison only, no IO.

- [ ] **Step 1: Create the YC company fixture**

Create `src/__tests__/fixtures/yc/yc-companies.json` with a representative sample (at minimum 30 companies). This is a curated list derived from the YC public company directory (https://www.ycombinator.com/companies). Full re-export can be done with the YC companies API or a manual export; the fixture is the stable subset used for matching.

```json
[
  "Airbnb",
  "Stripe",
  "Coinbase",
  "DoorDash",
  "Dropbox",
  "Reddit",
  "Twitch",
  "Instacart",
  "Gusto",
  "PagerDuty",
  "Segment",
  "Brex",
  "Rippling",
  "Deel",
  "Vercel",
  "Retool",
  "Amplitude",
  "PostHog",
  "Linear",
  "Loom",
  "Figma",
  "Notion",
  "Airtable",
  "Zapier",
  "GitLab",
  "Checkr",
  "Zenefits",
  "Weebly",
  "Cruise",
  "OpenAI",
  "Scale AI",
  "Weights and Biases",
  "Cohere",
  "Hugging Face",
  "Mistral AI",
  "Together AI",
  "Anyscale",
  "Modal",
  "Replicate",
  "Fal"
]
```

Update the fixture to include as many YC companies as practical. The list above is a minimum seed.

- [ ] **Step 2: Write the failing tests**

```typescript
// src/__tests__/radar/yc-matcher.test.ts
import { matchesYcBatch } from 'app/radar/yc-matcher.js';
import { describe, expect, it } from 'vitest';

describe('matchesYcBatch', () => {
  it('returns true for an exact name match', () => {
    expect(matchesYcBatch('Stripe')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesYcBatch('stripe')).toBe(true);
    expect(matchesYcBatch('STRIPE')).toBe(true);
  });

  it('matches after stripping leading/trailing whitespace', () => {
    expect(matchesYcBatch('  Stripe  ')).toBe(true);
  });

  it('returns false for a name not in the set', () => {
    expect(matchesYcBatch('RandomNonYcCompany')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(matchesYcBatch('')).toBe(false);
  });

  it('matches a multi-word YC company name', () => {
    expect(matchesYcBatch('Scale AI')).toBe(true);
  });

  it('returns false for a partial match (not a substring check)', () => {
    expect(matchesYcBatch('Strip')).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/radar/yc-matcher.test.ts`
Expected: FAIL with "Cannot find module 'app/radar/yc-matcher.js'".

- [ ] **Step 4: Implement yc-matcher.ts**

```typescript
// src/radar/yc-matcher.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load the checked-in YC company fixture at module init time.
// Pure: no env imports, no network. The fixture is the source of truth.
// Source: https://www.ycombinator.com/companies (exported 2026-06-01).
function loadYcSet(): Set<string> {
  const url = new URL(
    '../../__tests__/fixtures/yc/yc-companies.json',
    import.meta.url,
  );
  const raw = readFileSync(fileURLToPath(url), 'utf8');
  const names = JSON.parse(raw) as string[];
  return new Set(names.map((n) => n.trim().toLowerCase()));
}

const YC_COMPANIES: Set<string> = loadYcSet();

// Returns true if the company name matches a YC company (case-insensitive,
// trimmed exact match). Does not check substrings.
export function matchesYcBatch(companyName: string): boolean {
  const normalized = companyName.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return YC_COMPANIES.has(normalized);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/radar/yc-matcher.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/radar/yc-matcher.ts \
  src/__tests__/radar/yc-matcher.test.ts \
  src/__tests__/fixtures/yc/yc-companies.json
git commit -m "feat: YC batch matcher with checked-in fixture and unit tests"
```

---

## Task 5: Extend digest with draftAngle, test-first

**Files:**

- Modify: `src/radar/digest.ts`
- Modify: `src/__tests__/radar/digest.test.ts`

`draftAngle` is a pure function (company data in, angle string out). `buildDigestHtml` is extended to accept and render per-company angles. Existing tests must still pass.

- [ ] **Step 1: Write the failing tests (additions to existing file)**

Add to `src/__tests__/radar/digest.test.ts`:

```typescript
import { buildDigestHtml, draftAngle } from 'app/radar/digest.js';
import type { QueueRow } from 'app/radar/queries.js';
// ... existing imports unchanged ...

// Add these describe blocks after the existing ones:

describe('draftAngle', () => {
  it('returns a non-empty string for a company with a name', () => {
    const row: QueueRow = {
      id: 1,
      name: 'Cohere',
      warmth_score: '30',
      live_score: '45',
      status: 'discovered',
    };
    const angle = draftAngle(row);
    expect(typeof angle).toBe('string');
    expect(angle.length).toBeGreaterThan(0);
  });

  it('mentions the company name in the angle', () => {
    const row: QueueRow = {
      id: 2,
      name: 'Acme AI',
      warmth_score: '10',
      live_score: '20',
      status: 'discovered',
    };
    const angle = draftAngle(row);
    expect(angle).toContain('Acme AI');
  });

  it('returns a stable string for the same input', () => {
    const row: QueueRow = {
      id: 3,
      name: 'Stripe',
      warmth_score: '15',
      live_score: '22',
      status: 'researched',
    };
    expect(draftAngle(row)).toBe(draftAngle(row));
  });
});

describe('buildDigestHtml with angles', () => {
  it('renders per-company angle text in the output', () => {
    const queue: QueueRow[] = [
      {
        id: 1,
        name: 'Cohere',
        warmth_score: '30',
        live_score: '45',
        status: 'discovered',
      },
    ];
    const html = buildDigestHtml(queue, [], true);
    expect(html).toContain('Cohere');
    // The angle column or section must appear when withAngles is true.
    expect(html.toLowerCase()).toContain('angle');
  });
});
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `npx vitest run src/__tests__/radar/digest.test.ts`
Expected: FAIL (new tests fail; existing tests pass).

- [ ] **Step 3: Extend digest.ts**

Extend `src/radar/digest.ts` with `draftAngle` and update `buildDigestHtml` signature:

```typescript
// src/radar/digest.ts
import type { QueueRow, RejectRow } from 'app/radar/queries.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Returns a one-line outreach angle for the given queue row.
// Pure: same input always produces the same output.
export function draftAngle(row: QueueRow): string {
  const score = Number(row.live_score);
  if (score >= 40) {
    return `${escapeHtml(row.name)}: high-priority. Reach out referencing recent funding and open engineering roles.`;
  }
  if (score >= 25) {
    return `${escapeHtml(row.name)}: warm signal. Reference the product mission and ask about team growth plans.`;
  }
  return `${escapeHtml(row.name)}: on radar. Check LinkedIn for a mutual connection before reaching out.`;
}

export function buildDigestHtml(
  queue: QueueRow[],
  rejects: RejectRow[],
  withAngles = false,
): string {
  if (queue.length === 0) {
    return '<p>No companies in the outreach queue this week.</p>';
  }

  const angleCol = withAngles ? '<th>Angle</th>' : '';
  const rows = queue
    .map((r) => {
      const angleCell = withAngles
        ? `<td style="font-size:0.9em;color:#555">${draftAngle(r)}</td>`
        : '';
      return `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.status)}</td><td>${escapeHtml(r.live_score)}</td>${angleCell}</tr>`;
    })
    .join('');

  const rejectLines = rejects
    .map((r) => `${escapeHtml(r.reason)}: ${r.count}`)
    .join('<br/>');

  return `
    <h2>Outreach queue</h2>
    <table border="1" cellpadding="6">
      <tr><th>Company</th><th>Status</th><th>Score</th>${angleCol}</tr>
      ${rows}
    </table>
    <h3>Rejects this week</h3>
    <p>${rejectLines || 'none'}</p>
  `;
}
```

- [ ] **Step 4: Run all digest tests to verify they pass**

Run: `npx vitest run src/__tests__/radar/digest.test.ts`
Expected: PASS (all tests, including original and new).

- [ ] **Step 5: Commit**

```bash
git add src/radar/digest.ts src/__tests__/radar/digest.test.ts
git commit -m "feat: draftAngle helper and buildDigestHtml angle column"
```

---

## Task 6: Anthropic service client (IO, no unit coverage)

**Files:**

- Create: `src/services/anthropic.ts`

This is the IO layer for the Batch API. It reads `ANTHROPIC_API_KEY` from env. No unit tests (external network IO, excluded from coverage like `telegram.ts` and `email.ts`). It is exercised by the integration test in Task 7 using captured fixtures.

- [ ] **Step 1: Implement anthropic.ts**

```typescript
// src/services/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';
import { env } from 'app/config/env.js';
import { logger } from 'app/utils/logger.js';
import { buildClassifyPrompt } from 'app/radar/classify.js';

export interface ClassifyRequest {
  customId: string;
  companyName: string;
  description: string;
}

export interface BatchResultItem {
  customId: string;
  text: string | null;
  error: string | null;
}

function buildClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not configured; set it to use enrichment',
    );
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

// Submits a batch of classification requests to the Anthropic Batch API.
// Returns the batch id for later polling.
export async function submitClassifyBatch(
  requests: ClassifyRequest[],
): Promise<string> {
  const client = buildClient();
  const batch = await client.messages.batches.create({
    requests: requests.map((r) => ({
      custom_id: r.customId,
      params: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 64,
        messages: [
          {
            role: 'user' as const,
            content: buildClassifyPrompt(r.companyName, r.description),
          },
        ],
      },
    })),
  });
  logger.info(
    { batchId: batch.id, count: requests.length },
    'anthropic batch submitted',
  );
  return batch.id;
}

// Polls until the batch ends, then returns all results.
// Interval is 30 seconds; the nightly run has no latency requirement.
export async function pollBatchResults(
  batchId: string,
): Promise<BatchResultItem[]> {
  const client = buildClient();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  for (;;) {
    const status = await client.messages.batches.retrieve(batchId);
    logger.info(
      { batchId, processingStatus: status.processing_status },
      'anthropic batch poll',
    );
    if (status.processing_status === 'ended') break;
    await sleep(30_000);
  }

  const results: BatchResultItem[] = [];
  for await (const r of client.messages.batches.results(batchId)) {
    if (r.result.type === 'succeeded') {
      const content = r.result.message.content.find((c) => c.type === 'text');
      results.push({
        customId: r.custom_id,
        text: content?.type === 'text' ? content.text : null,
        error: null,
      });
    } else {
      results.push({ customId: r.custom_id, text: null, error: r.result.type });
    }
  }
  return results;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/services/anthropic.ts
git commit -m "feat: anthropic batch service client for nightly classify run"
```

---

## Task 7: Extend RadarDB interface and PgRadarDB for enrichment

**Files:**

- Modify: `src/radar/ingest.ts` (add three methods to RadarDB interface)
- Modify: `src/radar/db.ts` (implement three new methods on PgRadarDB)

Three new methods are needed by `enrich.ts`: fetching companies lacking an `ai_native_tag`, writing `ai_native_tag`/`ai_native_reason` back to the company row, and checking `hot_alerted_at`.

- [ ] **Step 1: Extend the RadarDB interface in ingest.ts**

In `src/radar/ingest.ts`, add to the `RadarDB` interface:

```typescript
// Returns company ids and names for gate-passers lacking an ai_native_tag,
// up to the given limit. Used by the nightly enrich job.
listUnclassified(limit: number): Promise<
  { id: number; name: string; description: string | null }[]
>;

// Persists the classifier output to the companies row.
setAiNativeTag(
  companyId: number,
  tag: string,
  reason: string,
): Promise<void>;

// Marks the company as hot-alerted. Sets hot_alerted_at = now().
markHotAlerted(companyId: number): Promise<void>;
```

- [ ] **Step 2: Implement in PgRadarDB**

Add three methods to the `PgRadarDB` class in `src/radar/db.ts`:

```typescript
async listUnclassified(
  limit: number,
): Promise<{ id: number; name: string; description: string | null }[]> {
  const { rows } = await query<{
    id: number;
    name: string;
    description: string | null;
  }>(
    `SELECT id, name, NULL AS description
       FROM companies
      WHERE ai_native_tag IS NULL
        AND status IN ('discovered', 'researched')
      ORDER BY warmth_score DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

async setAiNativeTag(
  companyId: number,
  tag: string,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE companies
        SET ai_native_tag = $2,
            ai_native_reason = $3,
            updated_at = now()
      WHERE id = $1`,
    [companyId, tag, reason],
  );
}

async markHotAlerted(companyId: number): Promise<void> {
  await query(
    `UPDATE companies SET hot_alerted_at = now() WHERE id = $1`,
    [companyId],
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If the `description` column does not exist in `companies`, the query returns NULL via alias - that is intentional; the column can be added in a future migration when a richer description source is wired.

- [ ] **Step 4: Write the failing integration tests**

```typescript
// src/__tests__/integration/enrich.test.ts
import { PgRadarDB } from 'app/radar/db.js';
import { pool, query } from 'app/db/pool.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const db = new PgRadarDB();

beforeEach(async () => {
  await query('TRUNCATE companies, filings, signals RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await pool.end();
});

describe('PgRadarDB enrichment methods', () => {
  it('listUnclassified returns companies without an ai_native_tag', async () => {
    await query(
      `INSERT INTO companies (name, status, warmth_score)
       VALUES ('Cohere', 'discovered', 30), ('Stripe', 'discovered', 10)`,
    );
    const rows = await db.listUnclassified(10);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.name)).toContain('Cohere');
  });

  it('listUnclassified excludes companies that already have a tag', async () => {
    await query(
      `INSERT INTO companies (name, status, warmth_score, ai_native_tag)
       VALUES ('Cohere', 'discovered', 30, 'yes'),
              ('Stripe', 'discovered', 10, NULL)`,
    );
    const rows = await db.listUnclassified(10);
    expect(rows.length).toBe(1);
    expect(rows[0]!.name).toBe('Stripe');
  });

  it('setAiNativeTag persists tag and reason', async () => {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO companies (name, status, warmth_score)
       VALUES ('Cohere', 'discovered', 30) RETURNING id`,
    );
    const id = rows[0]!.id;
    await db.setAiNativeTag(id, 'yes', 'LLM API is the core product');
    const { rows: updated } = await query<{
      ai_native_tag: string;
      ai_native_reason: string;
    }>('SELECT ai_native_tag, ai_native_reason FROM companies WHERE id = $1', [
      id,
    ]);
    expect(updated[0]!.ai_native_tag).toBe('yes');
    expect(updated[0]!.ai_native_reason).toBe('LLM API is the core product');
  });

  it('markHotAlerted sets hot_alerted_at and is idempotent on a second call', async () => {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO companies (name, status, warmth_score)
       VALUES ('Stripe', 'discovered', 50) RETURNING id`,
    );
    const id = rows[0]!.id;
    await db.markHotAlerted(id);
    const { rows: first } = await query<{ hot_alerted_at: string | null }>(
      'SELECT hot_alerted_at FROM companies WHERE id = $1',
      [id],
    );
    expect(first[0]!.hot_alerted_at).not.toBeNull();

    await db.markHotAlerted(id);
    const { rows: second } = await query<{ hot_alerted_at: string | null }>(
      'SELECT hot_alerted_at FROM companies WHERE id = $1',
      [id],
    );
    // Timestamp may differ slightly; the column should still be non-null.
    expect(second[0]!.hot_alerted_at).not.toBeNull();
  });
});
```

- [ ] **Step 5: Run to verify they fail**

Run: `npm run test:integration -- --reporter=verbose 2>&1 | grep -E 'FAIL|PASS|Cannot'`
Expected: FAIL on the new integration tests (module resolution passes; method calls fail if not yet implemented, or pass if implemented in step 2).

- [ ] **Step 6: Run to verify they pass**

Run: `npm run test:integration`
Expected: PASS (all integration tests, including the new enrichment ones).

- [ ] **Step 7: Commit**

```bash
git add src/radar/ingest.ts src/radar/db.ts src/__tests__/integration/enrich.test.ts
git commit -m "feat: extend RadarDB with enrichment methods and integration tests"
```

---

## Task 8: enrich.ts job entrypoint, integration-tested

**Files:**

- Create: `src/jobs/enrich.ts`

The enrich job orchestrates the nightly enrichment run. The LLM half uses captured fixtures in the test (no live network in CI). The persistence half is tested against real Postgres.

- [ ] **Step 1: Write the failing integration test**

Add to `src/__tests__/integration/enrich.test.ts` (after the existing `describe` block):

```typescript
import {
  runEnrich,
  type EnrichDB,
  type ClassifyService,
} from 'app/jobs/enrich.js';
import {
  parseClassifyResponse,
  type ClassifyResult,
} from 'app/radar/classify.js';
import { SIGNAL_WEIGHTS } from 'app/radar/config.js';

// Fake ClassifyService using the parser against the captured fixture.
// This is the LLM-half fixture test: real parser, captured model output,
// no network.
function fakeClassifyService(
  fixture: { customId: string; text: string }[],
): ClassifyService {
  return {
    async classify(
      requests: {
        customId: string;
        companyName: string;
        description: string;
      }[],
    ): Promise<{ customId: string; result: ClassifyResult }[]> {
      return requests.map((req) => {
        const found = fixture.find((f) => f.customId === req.customId);
        const result = parseClassifyResponse(
          found?.text ?? '{"tag":"maybe","reason":"fixture fallback"}',
        );
        return { customId: req.customId, result };
      });
    },
  };
}

describe('runEnrich orchestration', () => {
  beforeEach(async () => {
    await query(
      'TRUNCATE companies, filings, signals RESTART IDENTITY CASCADE',
    );
  });

  it('writes ai_native_tag and emits ai_native signal for a yes company', async () => {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO companies (name, status, warmth_score)
       VALUES ('Cohere', 'discovered', 20) RETURNING id`,
    );
    const companyId = rows[0]!.id;
    const enrichDb = new PgRadarDB();
    const svc = fakeClassifyService([
      {
        customId: String(companyId),
        text: '{"tag":"yes","reason":"LLM API core product"}',
      },
    ]);

    await runEnrich(enrichDb, svc);

    const { rows: tagged } = await query<{ ai_native_tag: string }>(
      'SELECT ai_native_tag FROM companies WHERE id = $1',
      [companyId],
    );
    expect(tagged[0]!.ai_native_tag).toBe('yes');

    const { rows: sig } = await query<{ type: string }>(
      "SELECT type FROM signals WHERE company_id = $1 AND type = 'ai_native'",
      [companyId],
    );
    expect(sig.length).toBe(1);
  });

  it('does not emit ai_native signal when tag is maybe', async () => {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO companies (name, status, warmth_score)
       VALUES ('Harvey', 'discovered', 10) RETURNING id`,
    );
    const companyId = rows[0]!.id;
    const enrichDb = new PgRadarDB();
    const svc = fakeClassifyService([
      {
        customId: String(companyId),
        text: '{"tag":"maybe","reason":"applied to legal"}',
      },
    ]);

    await runEnrich(enrichDb, svc);

    const { rows: sig } = await query<{ type: string }>(
      "SELECT type FROM signals WHERE company_id = $1 AND type = 'ai_native'",
      [companyId],
    );
    expect(sig.length).toBe(0);
  });

  it('emits yc_batch signal for a YC company', async () => {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO companies (name, status, warmth_score)
       VALUES ('Stripe', 'discovered', 15) RETURNING id`,
    );
    const companyId = rows[0]!.id;
    const enrichDb = new PgRadarDB();
    const svc = fakeClassifyService([
      {
        customId: String(companyId),
        text: '{"tag":"no","reason":"payments not AI"}',
      },
    ]);

    await runEnrich(enrichDb, svc);

    const { rows: sig } = await query<{ type: string }>(
      "SELECT type FROM signals WHERE company_id = $1 AND type = 'yc_batch'",
      [companyId],
    );
    expect(sig.length).toBe(1);
  });

  it('recomputes warmth after signal upsert', async () => {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO companies (name, status, warmth_score)
       VALUES ('Cohere', 'discovered', 0) RETURNING id`,
    );
    const companyId = rows[0]!.id;
    const enrichDb = new PgRadarDB();
    const svc = fakeClassifyService([
      {
        customId: String(companyId),
        text: '{"tag":"yes","reason":"LLM core"}',
      },
    ]);

    await runEnrich(enrichDb, svc);

    const { rows: c } = await query<{ warmth_score: string }>(
      'SELECT warmth_score FROM companies WHERE id = $1',
      [companyId],
    );
    // ai_native signal weight is 8.
    expect(Number(c[0]!.warmth_score)).toBeGreaterThanOrEqual(
      SIGNAL_WEIGHTS.ai_native,
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:integration`
Expected: FAIL with "Cannot find module 'app/jobs/enrich.js'".

- [ ] **Step 3: Implement enrich.ts**

```typescript
// src/jobs/enrich.ts
import 'dotenv/config';
import { logger } from 'app/utils/logger.js';
import { runJob } from 'app/jobs/runJob.js';
import { PgRadarDB } from 'app/radar/db.js';
import {
  parseClassifyResponse,
  type ClassifyResult,
} from 'app/radar/classify.js';
import { matchesYcBatch } from 'app/radar/yc-matcher.js';
import { SIGNAL_WEIGHTS } from 'app/radar/config.js';
import {
  submitClassifyBatch,
  pollBatchResults,
} from 'app/services/anthropic.js';
import type { RadarDB } from 'app/radar/ingest.js';

// ---------------------------------------------------------------------------
// Interfaces (allows test injection)
// ---------------------------------------------------------------------------

export interface ClassifyService {
  classify(
    requests: { customId: string; companyName: string; description: string }[],
  ): Promise<{ customId: string; result: ClassifyResult }[]>;
}

export type EnrichDB = Pick<
  RadarDB,
  'listUnclassified' | 'setAiNativeTag' | 'upsertSignals' | 'recomputeWarmth'
>;

// ---------------------------------------------------------------------------
// Default live classify service (uses real Anthropic Batch API)
// ---------------------------------------------------------------------------

function buildLiveClassifyService(): ClassifyService {
  return {
    async classify(requests) {
      const batchId = await submitClassifyBatch(requests);
      const results = await pollBatchResults(batchId);
      return results.map((r) => ({
        customId: r.customId,
        result: parseClassifyResponse(r.text ?? ''),
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Core orchestration (exported for integration testing)
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;

export async function runEnrich(
  db: EnrichDB,
  classifySvc: ClassifyService = buildLiveClassifyService(),
): Promise<void> {
  const companies = await db.listUnclassified(BATCH_SIZE);
  if (companies.length === 0) {
    logger.info('enrich: no unclassified companies; nothing to do');
    return;
  }

  logger.info({ count: companies.length }, 'enrich: classifying companies');

  const requests = companies.map((c) => ({
    customId: String(c.id),
    companyName: c.name,
    description: c.description ?? '',
  }));

  const results = await classifySvc.classify(requests);

  for (const { customId, result } of results) {
    const companyId = Number(customId);
    const company = companies.find((c) => c.id === companyId);
    if (!company) continue;

    await db.setAiNativeTag(companyId, result.tag, result.reason);
    logger.info(
      { companyId, name: company.name, tag: result.tag },
      'enrich: tag written',
    );

    const signals: { type: string; weight: number; source: string }[] = [];

    // Emit ai_native signal only when the effective tag is 'yes'.
    // The effective tag is COALESCE(ai_native_override_tag, ai_native_tag),
    // but at write time the override is not set, so the raw tag drives emission.
    // A later override write must re-emit or remove the signal manually.
    if (result.tag === 'yes') {
      signals.push({
        type: 'ai_native',
        weight: SIGNAL_WEIGHTS.ai_native,
        source: 'haiku',
      });
    }

    // Emit yc_batch signal for any YC company regardless of ai_native tag.
    if (matchesYcBatch(company.name)) {
      signals.push({
        type: 'yc_batch',
        weight: SIGNAL_WEIGHTS.yc_batch,
        source: 'yc_fixture',
      });
    }

    if (signals.length > 0) {
      await db.upsertSignals(companyId, signals);
    }

    await db.recomputeWarmth(companyId);
  }

  logger.info({ count: results.length }, 'enrich: complete');
}

// ---------------------------------------------------------------------------
// Cron entrypoint
// ---------------------------------------------------------------------------

await runJob('enrich', async () => {
  await runEnrich(new PgRadarDB());
});
```

- [ ] **Step 4: Run to verify integration tests pass**

Run: `npm run test:integration`
Expected: PASS (all existing + new enrich tests).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/enrich.ts src/__tests__/integration/enrich.test.ts
git commit -m "feat: nightly enrich job with batch classify, yc signal, and recomputeWarmth"
```

---

## Task 9: hot-alert.ts job, integration-tested

**Files:**

- Create: `src/jobs/hot-alert.ts`
- Create: `src/__tests__/integration/hot-alert.test.ts`

The hot-alert job runs hourly. It fetches companies above `HOT_THRESHOLD` that have not yet been alerted (`hot_alerted_at IS NULL`), calls `sendAlert` once per company, then writes `markHotAlerted`. The integration test verifies the single-fire behavior using a real Postgres row.

- [ ] **Step 1: Write the failing integration test**

```typescript
// src/__tests__/integration/hot-alert.test.ts
import { runHotAlert, type HotAlertDB } from 'app/jobs/hot-alert.js';
import { PgRadarDB } from 'app/radar/db.js';
import { pool, query } from 'app/db/pool.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as telegram from 'app/services/telegram.js';

beforeEach(async () => {
  await query('TRUNCATE companies, filings, signals RESTART IDENTITY CASCADE');
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
});

describe('runHotAlert', () => {
  it('sends one alert per hot company and marks it alerted', async () => {
    await query(
      `INSERT INTO companies (name, status, warmth_score)
       VALUES ('Cohere', 'discovered', 50)`,
    );
    const alertSpy = vi
      .spyOn(telegram, 'sendAlert')
      .mockResolvedValue(undefined);
    const db = new PgRadarDB();

    await runHotAlert(db);

    expect(alertSpy).toHaveBeenCalledOnce();
    expect(alertSpy.mock.calls[0]![0]).toContain('Cohere');

    const { rows } = await query<{ hot_alerted_at: string | null }>(
      "SELECT hot_alerted_at FROM companies WHERE name = 'Cohere'",
    );
    expect(rows[0]!.hot_alerted_at).not.toBeNull();
  });

  it('does not re-alert a company already marked hot_alerted_at', async () => {
    await query(
      `INSERT INTO companies (name, status, warmth_score, hot_alerted_at)
       VALUES ('Cohere', 'discovered', 50, now())`,
    );
    const alertSpy = vi
      .spyOn(telegram, 'sendAlert')
      .mockResolvedValue(undefined);
    const db = new PgRadarDB();

    await runHotAlert(db);

    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('does not alert companies below HOT_THRESHOLD', async () => {
    await query(
      `INSERT INTO companies (name, status, warmth_score)
       VALUES ('Low Score Co', 'discovered', 5)`,
    );
    const alertSpy = vi
      .spyOn(telegram, 'sendAlert')
      .mockResolvedValue(undefined);
    const db = new PgRadarDB();

    await runHotAlert(db);

    expect(alertSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:integration`
Expected: FAIL with "Cannot find module 'app/jobs/hot-alert.js'".

- [ ] **Step 3: Add listHotUnalerted to RadarDB and PgRadarDB**

In `src/radar/ingest.ts`, add to `RadarDB`:

```typescript
// Returns companies above the given warmth threshold not yet hot-alerted.
listHotUnalerted(
  threshold: number,
): Promise<{ id: number; name: string; warmth_score: number }[]>;
```

In `src/radar/db.ts`, implement:

```typescript
async listHotUnalerted(
  threshold: number,
): Promise<{ id: number; name: string; warmth_score: number }[]> {
  const { rows } = await query<{
    id: number;
    name: string;
    warmth_score: string;
  }>(
    `SELECT id, name, warmth_score
       FROM companies
      WHERE warmth_score >= $1
        AND hot_alerted_at IS NULL
        AND status IN ('discovered', 'researched')
      ORDER BY warmth_score DESC`,
    [threshold],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    warmth_score: Number(r.warmth_score),
  }));
}
```

- [ ] **Step 4: Implement hot-alert.ts**

```typescript
// src/jobs/hot-alert.ts
import 'dotenv/config';
import { logger } from 'app/utils/logger.js';
import { runJob } from 'app/jobs/runJob.js';
import { PgRadarDB } from 'app/radar/db.js';
import { sendAlert } from 'app/services/telegram.js';
import { HOT_THRESHOLD } from 'app/radar/config.js';
import type { RadarDB } from 'app/radar/ingest.js';

export type HotAlertDB = Pick<RadarDB, 'listHotUnalerted' | 'markHotAlerted'>;

export async function runHotAlert(db: HotAlertDB): Promise<void> {
  const companies = await db.listHotUnalerted(HOT_THRESHOLD);
  if (companies.length === 0) {
    logger.info('hot-alert: no new hot companies');
    return;
  }

  for (const c of companies) {
    const message =
      `[hot-alert] ${c.name} crossed the hot threshold ` +
      `(warmth: ${c.warmth_score}, threshold: ${HOT_THRESHOLD}). ` +
      'Time to reach out.';
    await sendAlert(message);
    await db.markHotAlerted(c.id);
    logger.info({ companyId: c.id, name: c.name }, 'hot-alert: alerted');
  }
}

await runJob('hot-alert', async () => {
  await runHotAlert(new PgRadarDB());
});
```

- [ ] **Step 5: Run to verify integration tests pass**

Run: `npm run test:integration`
Expected: PASS (all integration tests).

- [ ] **Step 6: Commit**

```bash
git add src/jobs/hot-alert.ts \
  src/__tests__/integration/hot-alert.test.ts \
  src/radar/ingest.ts \
  src/radar/db.ts
git commit -m "feat: hourly hot-alert job with single-fire idempotency"
```

---

## Task 10: Classifier eval harness

**Files:**

- Create: `scripts/eval-classifier.ts`

The eval harness runs the parser and prompt against captured batch outputs and reports accuracy against `labels.json`. It does not require live network in CI (uses captured outputs from `batch-response.json`). This is the "offline eval" described in spec section 7.

- [ ] **Step 1: Implement eval-classifier.ts**

```typescript
// scripts/eval-classifier.ts
// Offline classifier eval. Measures parser accuracy against a labeled set
// using captured Anthropic batch responses. Does not require live network.
//
// Usage: npx tsx scripts/eval-classifier.ts
//
// To run against live Anthropic (updates the captured outputs):
//   ANTHROPIC_API_KEY=<key> npx tsx scripts/eval-classifier.ts --live
//
// The eval measures the prompt + parser combination. Disagreements indicate
// either a labeling error or a prompt deficiency. Iterate the prompt in
// classify.ts, re-run --live to capture new outputs, then re-run offline.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseClassifyResponse } from '../src/radar/classify.js';

interface LabeledExample {
  name: string;
  description: string;
  expectedTag: string;
}

interface CapturedResult {
  custom_id: string;
  result: {
    type: string;
    message: {
      content: Array<{ type: string; text: string }>;
    };
  };
}

function loadJson<T>(relPath: string): T {
  const url = new URL(relPath, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as T;
}

const LABELS_PATH = '../src/__tests__/fixtures/ai-native/labels.json';
const CAPTURE_PATH = '../src/__tests__/fixtures/ai-native/batch-response.json';

const labels = loadJson<LabeledExample[]>(LABELS_PATH);

// In offline mode, use the captured results. In --live mode, submit a fresh
// batch (requires ANTHROPIC_API_KEY) and save new captured outputs.
const isLive = process.argv.includes('--live');

let capturedResults: CapturedResult[];

if (isLive) {
  console.log('Live mode: submitting batch to Anthropic...');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { buildClassifyPrompt } = await import('../src/radar/classify.js');
  const client = new Anthropic();

  const batch = await client.messages.batches.create({
    requests: labels.map((l, i) => ({
      custom_id: String(i),
      params: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 64,
        messages: [
          {
            role: 'user' as const,
            content: buildClassifyPrompt(l.name, l.description),
          },
        ],
      },
    })),
  });

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  for (;;) {
    const status = await client.messages.batches.retrieve(batch.id);
    process.stdout.write(`.`);
    if (status.processing_status === 'ended') break;
    await sleep(15_000);
  }
  console.log('\nBatch complete. Collecting results...');

  capturedResults = [];
  for await (const r of client.messages.batches.results(batch.id)) {
    capturedResults.push(r as CapturedResult);
  }

  const captureUrl = new URL(CAPTURE_PATH, import.meta.url);
  writeFileSync(
    fileURLToPath(captureUrl),
    JSON.stringify(capturedResults, null, 2),
  );
  console.log(`Saved captured outputs to ${CAPTURE_PATH}`);
} else {
  if (!existsSync(fileURLToPath(new URL(CAPTURE_PATH, import.meta.url)))) {
    console.error(
      'No captured results found. Run with --live first to capture outputs.',
    );
    process.exit(1);
  }
  capturedResults = loadJson<CapturedResult[]>(CAPTURE_PATH);
}

// Pair labels with captured results by index.
let correct = 0;
const disagreements: Array<{
  name: string;
  expected: string;
  got: string;
  reason: string;
}> = [];

for (let i = 0; i < labels.length; i++) {
  const label = labels[i]!;
  const captured = capturedResults.find((r) => r.custom_id === String(i));
  if (!captured || captured.result.type !== 'succeeded') {
    console.warn(
      `Warning: no captured result for label index ${i} (${label.name})`,
    );
    continue;
  }

  const text =
    captured.result.message.content.find((c) => c.type === 'text')?.text ?? '';
  const parsed = parseClassifyResponse(text);

  if (parsed.tag === label.expectedTag) {
    correct++;
  } else {
    disagreements.push({
      name: label.name,
      expected: label.expectedTag,
      got: parsed.tag,
      reason: parsed.reason,
    });
  }
}

const total = labels.length;
const accuracy = total > 0 ? ((correct / total) * 100).toFixed(1) : '0.0';

console.log(`\nClassifier eval results`);
console.log(`-----------------------`);
console.log(`Total:    ${total}`);
console.log(`Correct:  ${correct}`);
console.log(`Accuracy: ${accuracy}%`);

if (disagreements.length > 0) {
  console.log(`\nDisagreements (${disagreements.length}):`);
  for (const d of disagreements) {
    console.log(
      `  ${d.name}: expected=${d.expected}, got=${d.got}, reason="${d.reason}"`,
    );
  }
} else {
  console.log('\nNo disagreements.');
}

if (Number(accuracy) < 70) {
  console.error(
    '\nAccuracy below 70%: tune the prompt in src/radar/classify.ts.',
  );
  process.exit(1);
}
```

- [ ] **Step 2: Smoke-run in offline mode**

Run: `npx tsx scripts/eval-classifier.ts`
Expected: accuracy report printed, no crash. The script reads `labels.json` and `batch-response.json`. If the labels fixture has 10 entries and the captured fixture has 2 entries (the ones from Task 3), most labels will log a "no captured result" warning. That is correct; the captured fixture grows when `--live` is run with a full label set.

- [ ] **Step 3: Commit**

```bash
git add scripts/eval-classifier.ts
git commit -m "feat: offline classifier eval harness with accuracy report"
```

---

## Task 11: Extend weekly-digest entrypoint with angles

**Files:**

- Modify: `src/jobs/weekly-digest.ts`

Pass `withAngles = true` to `buildDigestHtml` so the digest includes per-company outreach angles.

- [ ] **Step 1: Modify the entrypoint**

In `src/jobs/weekly-digest.ts`, change the `buildDigestHtml` call to pass `true` as the third argument:

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
    buildDigestHtml(queue, rejects, true),
  );
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/jobs/weekly-digest.ts
git commit -m "feat: weekly digest includes per-company outreach angles"
```

---

## Task 12: Railway cron table + README update

**Files:**

- Modify: `README.md`

Add `enrich` (daily 08:00) and `hot-alert` (hourly) to the Railway cron schedule table. This is the documentation task required by project rules when adding user-facing features.

- [ ] **Step 1: Update README.md**

Find the Railway cron schedule table in `README.md` (added in Phase 1 Task 13). Add two rows:

```markdown
| `enrich` | daily 08:00 | `node dist/jobs/enrich.ts` | Haiku AI-native tagging and YC cross-ref for new gate-passers |
| `hot-alert` | hourly | `node dist/jobs/hot-alert.ts` | Push companies crossing the hot threshold via Telegram, once each |
```

Also add a note under the table:

> The `HOT_THRESHOLD` constant in `src/radar/config.ts` controls the warmth cutoff for hot-alerts (default: 45). Adjust before deploy if the queue is too noisy or too quiet.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add enrich and hot-alert to Railway cron table in README"
```

---

## Self-Review

### Spec coverage

**Section 6 (Phase 2: enrichment):**

- Haiku 4.5 via Batch API: Task 6 (`submitClassifyBatch`, `pollBatchResults`). No prompt caching added. Cost lever is batch only, as specified.
- Classification contract `{"tag":"yes"|"maybe"|"no","reason":"<= 12 words"}`: Task 3 (`classifySchema`, zod parse, word truncation).
- Trust-but-verify (`COALESCE(ai_native_override_tag, ai_native_tag)`): documented in `enrich.ts` comment; `ai_native_override_tag` column exists in migration 0001; the signal emission reads the raw tag at write time and a human override requires a manual signal re-emit (noted in code comment, consistent with spec).
- YC cross-reference with `yc_batch` signal (weight 3): Task 4 and Task 8.
- `recomputeWarmth` after signals: Task 8 (`runEnrich` calls `db.recomputeWarmth`).

**Section 7 (Evaluation):**

- AI-native classifier eval harness with labeled set and accuracy report: Tasks 3 and 10.
- LLM-consumer fixture test (real captured response, not mocked SDK): Task 3, Step 6, fixture test in `classify.test.ts`.
- Eval does not require live network in CI: `eval-classifier.ts` offline mode uses `batch-response.json`.

**Section 8 (Orchestration):**

- `enrich` daily 08:00 wrapped in `runJob`: Task 8 (`runEnrich` + cron entrypoint).
- `hot-alert` hourly, once each, tracked via `hot_alerted_at`: Tasks 2 (migration) and 9.
- Weekly digest with drafted outreach angles: Tasks 5 and 11.

**Section 10, step 4 (Enrichment and alerts):**

- Haiku AI-native tagging via Batch: Tasks 3, 6, 8.
- YC cross-ref: Task 4.
- Weekly digest with drafted angles: Tasks 5, 11.
- Hot-match push: Task 9.

### Placeholder scan

No `TODO`, `FIXME`, `<placeholder>`, or `[insert]` patterns appear in any code block. The `description` column in `listUnclassified` returns NULL via SQL alias and is documented; it is intentional, not a stub.

### Type consistency

- `RadarDB` and `SignalInput` remain in `src/radar/ingest.ts`; three new methods added in Task 7 and one in Task 9.
- `PgRadarDB` implements all new methods.
- `ClassifyResult` and `AiNativeTag` owned by `src/radar/classify.ts`; consumed by `src/jobs/enrich.ts` and `scripts/eval-classifier.ts`.
- `ClassifyService` and `EnrichDB` defined in `src/jobs/enrich.ts`; `HotAlertDB` defined in `src/jobs/hot-alert.ts`. Both use `Pick<RadarDB, ...>` to avoid duplicating the full interface.
- `buildDigestHtml` signature change (`withAngles = false`) is backward-compatible; the Phase 1 test calls it without the third argument and continues to pass.
- `SIGNAL_WEIGHTS.ai_native` (8) and `SIGNAL_WEIGHTS.yc_batch` (3) consumed from `src/radar/config.ts`; `HOT_THRESHOLD` (45) added to the same file in Task 1.
- All imports use `app/*` alias with `.js` extensions (NodeNext ESM).
- Pure modules (`classify.ts`, `yc-matcher.ts`, `digest.ts`) do not import `app/config/env.js`.
