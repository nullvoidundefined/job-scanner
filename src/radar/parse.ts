import { XMLParser } from 'fast-xml-parser';
import type { ParsedFormD, Relationship } from 'app/radar/form-d-filter.js';

export interface FilingPointer {
  cik: string;
  companyName: string;
  formType: string;
  dateFiled: string;
  accessionNumber: string;
}

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// Parses a daily master.idx body. Lines: CIK|Company|Form Type|Date Filed|Filename
export function parseDailyIndex(body: string): FilingPointer[] {
  const pointers: FilingPointer[] = [];
  for (const line of body.split('\n')) {
    const parts = line.split('|');
    if (parts.length !== 5) continue;
    const [cik, companyName, formType, dateFiled, filename] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
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

// Maps a primary_doc.xml string to ParsedFormD, or null if not a Form D submission.
// accessionNumber/cik/formType/filingDate come from the index pointer, so the caller
// supplies them; this function fills the rest from the document.
export function parseFormDXml(
  text: string,
  pointer?: Partial<FilingPointer>,
): ParsedFormD | null {
  const root = xml.parse(text)?.edgarSubmission;
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
  if (sec.isOptionToAcquireType === 'true') {
    securitiesTypes.push('Option/Warrant');
  }
  if (sec.isOtherType === 'true') securitiesTypes.push('Other');

  const raw = amounts.totalOfferingAmount;
  const totalOfferingAmount =
    raw === 'Indefinite' ? 'indefinite' : raw != null ? Number(raw) : null;

  const relatedPersons = asArray<Record<string, unknown>>(
    root.relatedPersonsList?.relatedPersonInfo,
  ).map((rp) => {
    const n = (rp.relatedPersonName ?? {}) as Record<string, string>;
    return {
      fullName: [n.firstName, n.middleName, n.lastName]
        .filter(Boolean)
        .join(' '),
      relationships: asArray<string>(
        (
          rp.relatedPersonRelationshipList as
            | Record<string, unknown>
            | undefined
        )?.relationship as string | string[] | undefined,
      ) as Relationship[],
    };
  });

  const yearVal = issuer.yearOfInc?.value;
  const formType = (pointer?.formType ?? 'D') as 'D' | 'D/A';

  return {
    accessionNumber: pointer?.accessionNumber ?? '',
    cik: pointer?.cik ?? String(issuer.cik ?? ''),
    formType,
    isAmendment:
      formType === 'D/A' ||
      offering.typeOfFiling?.newOrAmendment?.isAmendment === 'true',
    filingDate: pointer?.dateFiled ?? '',
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
