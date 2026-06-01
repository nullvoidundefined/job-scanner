// form-d-filter.ts
// Gate-then-score filter for Form D filings. Gates reject hard and fail fast.
//
// This emits only the SYNCHRONOUS signals derivable from a single filing
// (target_metro, young_company, stage). It does NOT emit recency: recency is computed
// at read time in the digest query so it decays correctly (see scoring.ts). History
// signals (first_raise, round_grew) are emitted by the ingest layer, which can see the
// company's other filings; enrichment signals (ai_native, hiring_eng, yc_batch) are
// emitted by the enrichment layer.

import {
  INDUSTRY_ALLOWLIST,
  SIZE_BAND_MIN,
  SIZE_BAND_MAX,
  STAGE_SEED_MAX,
  YOUNG_COMPANY_MAX_AGE_YEARS,
  TARGET_METROS,
  SIGNAL_WEIGHTS,
  type SignalType,
} from './config';

export type Relationship = 'Executive Officer' | 'Director' | 'Promoter';

export interface RelatedPerson {
  fullName: string;
  relationships: Relationship[];
}

// Normalized output of the XML parser. The seam between ingest and this filter.
export interface ParsedFormD {
  accessionNumber: string;
  cik: string;
  formType: 'D' | 'D/A';
  isAmendment: boolean;
  filingDate: string; // ISO date
  dateOfFirstSale: string | null;
  industryGroupType: string | null;
  isPooledFund: boolean;
  securitiesTypes: string[]; // captured, not gated
  totalOfferingAmount: number | 'indefinite' | null;
  totalAmountSold: number | null;
  issuer: {
    name: string;
    entityType: string | null;
    yearOfInc: number | null;
    city: string | null;
    state: string | null; // USPS code or country
    zip: string | null;
  };
  relatedPersons: RelatedPerson[];
}

export interface EmittedSignal {
  type: SignalType;
  weight: number;
  source: 'form_d';
}

export interface FilterResult {
  verdict: 'passed' | 'rejected';
  rejectReason?: string;
  signals: EmittedSignal[]; // synchronous Form D signals only
}

// ---- Gates: return a reject reason, or null to pass ----

function failGate(f: ParsedFormD): string | null {
  if (f.formType !== 'D' && f.formType !== 'D/A') return 'not a Form D';

  // The biggest noise killer: hedge, PE, VC funds, SPVs.
  if (f.isPooledFund) return 'pooled investment fund';

  if (!f.industryGroupType || !INDUSTRY_ALLOWLIST.has(f.industryGroupType)) {
    return `industry not in allowlist (${f.industryGroupType ?? 'none'})`;
  }

  // (Securities-type gate intentionally omitted: favor recall over precision.)

  const amt = f.totalOfferingAmount;
  if (amt === 'indefinite') return 'indefinite offering amount (likely a fund)';
  if (amt === null) return 'no offering amount';
  if (amt < SIZE_BAND_MIN || amt > SIZE_BAND_MAX)
    return `offering amount out of band (${amt})`;

  const hasPrincipal = f.relatedPersons.some(
    (p) =>
      p.relationships.includes('Executive Officer') ||
      p.relationships.includes('Director'),
  );
  if (!hasPrincipal) return 'no officer or director named';

  return null;
}

// ---- Synchronous signals: derivable from a single filing ----

function syncSignals(f: ParsedFormD, now: Date): EmittedSignal[] {
  const out: EmittedSignal[] = [];
  const push = (type: SignalType) =>
    out.push({ type, weight: SIGNAL_WEIGHTS[type], source: 'form_d' });

  // Target metro.
  const city = f.issuer.city?.toLowerCase() ?? '';
  if (
    TARGET_METROS.some((m) => m.state === f.issuer.state && m.cities.has(city))
  ) {
    push('target_metro');
  }

  // Young company.
  if (
    f.issuer.yearOfInc !== null &&
    now.getFullYear() - f.issuer.yearOfInc <= YOUNG_COMPANY_MAX_AGE_YEARS
  ) {
    push('young_company');
  }

  // Stage from offering amount (gate guarantees a numeric, in-band amount here).
  if (typeof f.totalOfferingAmount === 'number') {
    push(f.totalOfferingAmount <= STAGE_SEED_MAX ? 'seed' : 'series_a');
  }

  return out;
}

// Pure. The ingest layer persists the verdict, adds history signals, and recomputes warmth.
export function evaluate(
  filing: ParsedFormD,
  now: Date = new Date(),
): FilterResult {
  const reason = failGate(filing);
  if (reason) return { verdict: 'rejected', rejectReason: reason, signals: [] };
  return { verdict: 'passed', signals: syncSignals(filing, now) };
}
