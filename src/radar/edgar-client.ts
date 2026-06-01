import { env } from 'app/config/env.js';
import { MIN_REQUEST_SPACING_MS } from 'app/radar/config.js';
import type { ParsedFormD } from 'app/radar/form-d-filter.js';
import {
  parseDailyIndex,
  parseFormDXml,
  type FilingPointer,
} from 'app/radar/parse.js';

const ARCHIVES = 'https://www.sec.gov/Archives';

let lastRequestAt = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function secFetch(url: string, attempt = 0): Promise<Response> {
  const wait = MIN_REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const res = await fetch(url, {
    headers: { 'User-Agent': env.SEC_USER_AGENT },
  });
  if ((res.status === 429 || res.status === 503) && attempt < 4) {
    await sleep(2 ** attempt * 1000);
    return secFetch(url, attempt + 1);
  }
  return res;
}

const quarterOf = (month: number) => Math.floor((month - 1) / 3) + 1;

export async function listFormDFilings(date: string): Promise<FilingPointer[]> {
  const [y, m, d] = date.split('-') as [string, string, string];
  const url = `${ARCHIVES}/edgar/daily-index/${y}/QTR${quarterOf(Number(m))}/master.${y}${m}${d}.idx`;
  const res = await secFetch(url);
  if (res.status === 404) return []; // weekend / holiday
  if (!res.ok) throw new Error(`daily index ${url} -> ${res.status}`);
  return parseDailyIndex(await res.text());
}

export function primaryDocUrl(cik: string, accession: string): string {
  return `${ARCHIVES}/edgar/data/${cik}/${accession.replace(/-/g, '')}/primary_doc.xml`;
}

export async function fetchAndParse(
  p: FilingPointer,
): Promise<ParsedFormD | null> {
  const res = await secFetch(primaryDocUrl(p.cik, p.accessionNumber));
  if (!res.ok) return null;
  return parseFormDXml(await res.text(), p);
}
