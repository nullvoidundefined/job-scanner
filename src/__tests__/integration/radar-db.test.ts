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
