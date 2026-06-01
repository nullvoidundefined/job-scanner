import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDailyIndex, parseFormDXml } from 'app/radar/parse.js';
import { describe, expect, it } from 'vitest';

function fixture(name: string): string {
  const url = new URL(`../fixtures/form-d/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}

describe('parseFormDXml', () => {
  it('maps a clean filing to ParsedFormD', () => {
    const parsed = parseFormDXml(fixture('clean.xml'));
    expect(parsed).not.toBeNull();
    expect(parsed!.issuer.name.length).toBeGreaterThan(0);
    expect(parsed!.isPooledFund).toBe(false);
  });

  it('flags a pooled investment fund', () => {
    const parsed = parseFormDXml(fixture('pooled-fund.xml'));
    expect(parsed!.isPooledFund).toBe(true);
  });

  it('maps an Indefinite offering amount to the "indefinite" sentinel', () => {
    const parsed = parseFormDXml(fixture('indefinite.xml'));
    expect(parsed!.totalOfferingAmount).toBe('indefinite');
  });

  it('joins a name with no middle name without a double space', () => {
    const parsed = parseFormDXml(fixture('no-middle-name.xml'));
    expect(parsed!.relatedPersons[0]!.fullName).not.toContain('  ');
  });

  it('returns null for XML without an edgarSubmission root', () => {
    expect(parseFormDXml('<nonsense/>')).toBeNull();
  });
});

describe('parseDailyIndex', () => {
  it('keeps only D and D/A rows and derives the accession number', () => {
    const pointers = parseDailyIndex(fixture('master-sample.idx'));
    expect(pointers.length).toBeGreaterThan(0);
    expect(
      pointers.every((p) => p.formType === 'D' || p.formType === 'D/A'),
    ).toBe(true);
    expect(pointers[0]!.accessionNumber).not.toContain('/');
    expect(pointers[0]!.accessionNumber).not.toContain('.txt');
  });
});
