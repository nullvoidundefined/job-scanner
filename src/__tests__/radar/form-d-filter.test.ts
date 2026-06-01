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
