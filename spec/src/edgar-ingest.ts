// edgar-ingest.ts
// EDGAR ingestion client. Walks the daily index, pulls each Form D's primary_doc.xml,
// normalizes to ParsedFormD, runs the gate-then-score filter, and persists through the
// id-keyed model: upsert the company, insert the filing, add the synchronous and
// history signals, recompute warmth.
//
// Requires: fast-xml-parser  (npm i fast-xml-parser). Node 18+ for global fetch.

import { XMLParser } from 'fast-xml-parser';
import { evaluate, type ParsedFormD, type Relationship } from './form-d-filter';
import { USER_AGENT, MIN_REQUEST_SPACING_MS, SIGNAL_WEIGHTS } from './config';

const ARCHIVES = 'https://www.sec.gov/Archives';

// ---- Throttled fetch with mandatory UA and basic backoff ----

let lastRequestAt = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function secFetch(url: string, attempt = 0): Promise<Response> {
  const wait = MIN_REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if ((res.status === 429 || res.status === 503) && attempt < 4) {
    await sleep(2 ** attempt * 1000);
    return secFetch(url, attempt + 1);
  }
  return res;
}

// ---- Step 1: daily index -> Form D filing pointers ----

export interface FilingPointer {
  cik: string;
  companyName: string;
  formType: string;
  dateFiled: string;
  accessionNumber: string;
}

const quarterOf = (month: number) => Math.floor((month - 1) / 3) + 1;

export async function listFormDFilings(date: string): Promise<FilingPointer[]> {
  const [y, m, d] = date.split('-');
  const url = `${ARCHIVES}/edgar/daily-index/${y}/QTR${quarterOf(Number(m))}/master.${y}${m}${d}.idx`;

  const res = await secFetch(url);
  if (res.status === 404) return []; // weekend / holiday
  if (!res.ok) throw new Error(`daily index ${url} -> ${res.status}`);

  const pointers: FilingPointer[] = [];
  for (const line of (await res.text()).split('\n')) {
    const parts = line.split('|'); // CIK|Company Name|Form Type|Date Filed|Filename
    if (parts.length !== 5) continue;
    const [cik, companyName, formType, dateFiled, filename] = parts;
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

// ---- Step 2: fetch + parse one filing ----

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false });
const primaryDocUrl = (cik: string, accession: string) =>
  `${ARCHIVES}/edgar/data/${cik}/${accession.replace(/-/g, '')}/primary_doc.xml`;

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export async function fetchAndParse(
  p: FilingPointer,
): Promise<ParsedFormD | null> {
  const res = await secFetch(primaryDocUrl(p.cik, p.accessionNumber));
  if (!res.ok) return null;

  const root = xml.parse(await res.text())?.edgarSubmission;
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

  const relatedPersons = asArray<any>(
    root.relatedPersonsList?.relatedPersonInfo,
  ).map((rp) => {
    const n = rp.relatedPersonName ?? {};
    return {
      fullName: [n.firstName, n.middleName, n.lastName]
        .filter(Boolean)
        .join(' '),
      relationships: asArray<string>(
        rp.relatedPersonRelationshipList?.relationship,
      ) as Relationship[],
    };
  });

  const yearVal = issuer.yearOfInc?.value;

  return {
    accessionNumber: p.accessionNumber,
    cik: p.cik,
    formType: p.formType as 'D' | 'D/A',
    isAmendment:
      p.formType === 'D/A' ||
      offering.typeOfFiling?.newOrAmendment?.isAmendment === 'true',
    filingDate: p.dateFiled,
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

// ---- Step 3: persistence seam (id-keyed) ----
// Wire to your data layer. History lookups happen BEFORE this filing is inserted.

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

  // companyId is null for rejected filings (funds, real estate: no company created).
  insertFiling(
    filing: ParsedFormD,
    companyId: number | null,
    verdict: 'passed' | 'rejected',
    rejectReason: string | null,
  ): Promise<void>;

  // Upsert on (company_id, type) so reruns do not duplicate and inflate the score.
  upsertSignals(companyId: number, signals: SignalInput[]): Promise<void>;

  // Sum stored signal weights + connection weight into companies.warmth_score.
  recomputeWarmth(companyId: number): Promise<void>;
}

// ---- Step 4: orchestrate a day ----

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
      await db.insertFiling(parsed, null, 'rejected', result.rejectReason!);
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
