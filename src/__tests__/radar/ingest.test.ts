import { ingestDay, type RadarDB } from 'app/radar/ingest.js';
import type { ParsedFormD } from 'app/radar/form-d-filter.js';
import * as client from 'app/radar/edgar-client.js';
import { describe, expect, it, vi } from 'vitest';

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

// Minimal in-memory RadarDB recording the signals upserted per company.
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
