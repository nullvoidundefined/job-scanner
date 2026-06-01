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
