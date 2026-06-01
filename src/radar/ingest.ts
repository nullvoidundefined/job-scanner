// ingest.ts
// Orchestrates a day of Form D ingestion through the id-keyed model: dedupe on
// accession, gate-then-score, look at history BEFORE inserting the current
// filing (for first_raise / round_grew), then upsert signals and recompute
// warmth. The RadarDB interface is the persistence seam.

import { SIGNAL_WEIGHTS } from 'app/radar/config.js';
import { fetchAndParse, listFormDFilings } from 'app/radar/edgar-client.js';
import { evaluate } from 'app/radar/form-d-filter.js';
import type { ParsedFormD } from 'app/radar/form-d-filter.js';

export interface SignalInput {
  type: string;
  weight: number;
  source: string;
}

export interface RadarDB {
  filingExists(accession: string): Promise<boolean>;

  // History, queried before inserting the current filing.
  priorFilingCount(cik: string): Promise<number>;
  maxPriorOfferingAmount(cik: string): Promise<number | null>;

  // Upsert the operating company on cik; returns companies.id.
  upsertCompanyFromFiling(filing: ParsedFormD): Promise<number>;

  // companyId is null for rejected filings (funds, real estate: no company).
  insertFiling(
    filing: ParsedFormD,
    companyId: number | null,
    verdict: 'passed' | 'rejected',
    rejectReason: string | null,
  ): Promise<void>;

  // Upsert on (company_id, type) so reruns do not duplicate and inflate score.
  upsertSignals(companyId: number, signals: SignalInput[]): Promise<void>;

  // Sum stored signal weights + connection weight into companies.warmth_score.
  recomputeWarmth(companyId: number): Promise<void>;
}

export async function ingestDay(
  date: string,
  db: RadarDB,
): Promise<{ seen: number; passed: number }> {
  const pointers = await listFormDFilings(date);
  let passed = 0;

  for (const p of pointers) {
    if (await db.filingExists(p.accessionNumber)) continue; // dedupe on accession
    const parsed = await fetchAndParse(p);
    if (!parsed) continue;

    const result = evaluate(parsed);

    if (result.verdict === 'rejected') {
      await db.insertFiling(
        parsed,
        null,
        'rejected',
        result.rejectReason ?? null,
      );
      continue;
    }

    // Look at history BEFORE inserting this filing.
    const priorCount = await db.priorFilingCount(parsed.cik);
    const priorMax = await db.maxPriorOfferingAmount(parsed.cik);

    const companyId = await db.upsertCompanyFromFiling(parsed);
    await db.insertFiling(parsed, companyId, 'passed', null);

    const signals: SignalInput[] = result.signals.map((s) => ({
      type: s.type,
      weight: s.weight,
      source: s.source,
    }));

    // Free history signals.
    if (priorCount === 0) {
      signals.push({
        type: 'first_raise',
        weight: SIGNAL_WEIGHTS.first_raise,
        source: 'form_d',
      });
    }
    const amt =
      typeof parsed.totalOfferingAmount === 'number'
        ? parsed.totalOfferingAmount
        : null;
    if (
      parsed.isAmendment &&
      amt !== null &&
      priorMax !== null &&
      amt > priorMax
    ) {
      signals.push({
        type: 'round_grew',
        weight: SIGNAL_WEIGHTS.round_grew,
        source: 'form_d',
      });
    }

    await db.upsertSignals(companyId, signals);
    await db.recomputeWarmth(companyId);
    passed++;
  }
  return { seen: pointers.length, passed };
}
