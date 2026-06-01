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
