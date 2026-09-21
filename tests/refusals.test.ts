/**
 * Tests for the refusal rules.
 *
 * These are the tests that matter: each one pins a case where the honest
 * answer is "we are not going to tell you that". The last test is the
 * strongest claim the service makes - that no number reaches the caller
 * without verbatim source text behind it - and it is enforced by walking
 * the whole response rather than by checking fields one at a time.
 */

import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extract } from '@/lib/extract/extract';
import { readPages } from '@/lib/extract/pdf';
import { lineArithmeticRefusals } from '@/lib/extract/rules';
import type { ExtractionResult, LineItem, Refusal } from '@/lib/extract/types';

const SAMPLES = path.resolve(__dirname, '../samples');

function bytes(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(SAMPLES, name)));
}

async function run(name: string): Promise<ExtractionResult> {
  return extract(bytes(name), name);
}

const codes = (rs: Refusal[]) => rs.map((r) => r.code);

/** Every number anywhere in the payload, with the evidence attached to it. */
function tracedNumbers(result: ExtractionResult) {
  const out: { value: number; page: number; sourceText: string; where: string }[] = [];

  const take = (t: { value: number; evidence: { page: number; sourceText: string } } | null, where: string) => {
    if (t) out.push({ value: t.value, page: t.evidence.page, sourceText: t.evidence.sourceText, where });
  };

  for (const item of result.lineItems) {
    const at = `p${item.page} line ${item.lineNumber}`;
    take(item.quantity, `${at} quantity`);
    take(item.unitPrice, `${at} unitPrice`);
    take(item.lineTotal, `${at} lineTotal`);
  }
  for (const page of result.pages) take(page.statedTotal, `p${page.page} statedTotal`);
  take(result.documentTotal, 'documentTotal');

  return out;
}

describe('a page with no text layer', () => {
  test('is refused outright, and invents nothing in its place', async () => {
    const result = await run('KBS-10241.pdf');

    expect(result.lineItems).toHaveLength(0);
    expect(result.documentTotal).toBeNull();
    expect(codes(result.refusals)).toContain('NO_TEXT_LAYER');

    const refusal = result.refusals.find((r) => r.code === 'NO_TEXT_LAYER')!;
    expect(refusal.page).toBe(1);
    // The document really does show $2,002.40 in its pixels. Producing that
    // figure from a page we cannot read is the exact failure being guarded.
    expect(JSON.stringify(result)).not.toContain('2002.4');
    expect(tracedNumbers(result)).toHaveLength(0);
  });
});

describe('an unreadable page inside a readable document', () => {
  test('is contained, and the other pages still return their items', async () => {
    const result = await run('KBS-DR118.pdf');

    const refused = result.pages.filter((p) => !p.extracted).map((p) => p.page);
    expect(refused).toEqual([4]);

    // Seven readable pages, three line items each.
    const readable = result.pages.filter((p) => p.extracted);
    expect(readable.map((p) => p.page)).toEqual([1, 2, 3, 5, 6, 7, 8]);
    expect(result.lineItems).toHaveLength(21);

    const refusal = result.refusals.find((r) => r.code === 'NO_TEXT_LAYER')!;
    expect(refusal.page).toBe(4);
  });

  test('withholds the document total and says why, rather than summing pages', async () => {
    const result = await run('KBS-DR118.pdf');

    expect(result.documentTotal).toBeNull();

    // 7 readable pages x $669.00 = $4,683.00 is the plausible-looking wrong
    // answer. It must not appear anywhere in the response.
    expect(JSON.stringify(result)).not.toContain('4683');

    const absent = result.refusals.find((r) => r.code === 'DOCUMENT_TOTAL_ABSENT')!;
    expect(absent.humanMessage).toMatch(/page 4 is a scan/i);
    expect(absent.humanMessage).toMatch(/summary/i);
    expect(absent.humanMessage).toMatch(/returns note/i);
    expect(absent.humanMessage).toMatch(/credit adjustment/i);

    // Pages that restate the same amounts are flagged, not silently merged.
    expect(codes(result.refusals)).toContain('POSSIBLE_DUPLICATE_PAGE');
  });

  test('flags two sites sharing one address without choosing between them', async () => {
    const result = await run('KBS-DR118.pdf');

    const contradiction = result.refusals.find(
      (r) => r.code === 'CONTRADICTORY_STATEMENT' && r.field === 'site',
    )!;
    expect(contradiction).toBeDefined();
    expect(contradiction.evidence.map((e) => e.page).sort()).toEqual([1, 2]);
  });
});

describe('a document whose total does not match its lines', () => {
  test('reports neither figure as the answer, and quotes both', async () => {
    const result = await run('KBS-10270.pdf');

    // The printed total is still visible at page level, because it is printed.
    expect(result.pages[0].statedTotal?.value).toBe(1612.9);
    // But no document total is certified.
    expect(result.documentTotal).toBeNull();

    const mismatch = result.refusals.find((r) => r.code === 'DOCUMENT_TOTAL_MISMATCH')!;
    expect(mismatch.humanMessage).toContain('$1,612.90');
    expect(mismatch.humanMessage).toContain('$1,538.20');
    expect(mismatch.humanMessage).toContain('$74.70');

    // All four lines are still extracted; the mismatch is at document level.
    expect(result.lineItems).toHaveLength(4);
  });
});

describe('a document that prints no line totals', () => {
  test('leaves them null rather than multiplying quantity by unit price', async () => {
    const result = await run('KBS-10255.pdf');

    expect(result.lineItems).toHaveLength(4);
    for (const item of result.lineItems) {
      expect(item.lineTotal).toBeNull();
    }

    // 1200 x $0.09 = $108.00 and 4 x $68.00 = $272.00 are the tempting
    // derivations. Neither may appear anywhere in the payload.
    const json = JSON.stringify(result);
    expect(json).not.toContain('108');
    expect(json).not.toContain('272');

    expect(codes(result.refusals)).toContain('VALUE_NOT_PRINTED');
    expect(codes(result.refusals)).toContain('DOCUMENT_TOTAL_ABSENT');
  });

  test('flags the weight column that changes meaning between rows', async () => {
    const result = await run('KBS-10255.pdf');

    const ambiguous = result.refusals.find((r) => r.code === 'AMBIGUOUS_UNIT_SEMANTICS')!;
    expect(ambiguous).toBeDefined();
    expect(ambiguous.evidence.map((e) => e.sourceText)).toContain('480g total');
  });

  test('still recovers the unit from the price cell, with that cell as evidence', async () => {
    const result = await run('KBS-10255.pdf');

    const nails = result.lineItems.find((i) => i.description.value.includes('Galv nails'))!;
    expect(nails.unit?.value).toBe('bag');
    expect(nails.unit?.evidence.sourceText).toBe('$68.00 /bag');
  });
});

describe('a contradiction in the prose', () => {
  test('is surfaced without poisoning the line items around it', async () => {
    const result = await run('KBS-10262.pdf');

    const pallets = result.refusals.find(
      (r) => r.code === 'CONTRADICTORY_STATEMENT' && r.field === 'pallet',
    )!;
    expect(pallets.humanMessage).toContain('14 and 16');
    expect(pallets.evidence).toHaveLength(2);

    // The money on this document is internally consistent, so it is published.
    expect(result.lineItems).toHaveLength(3);
    expect(result.documentTotal?.value).toBe(5122.4);
  });
});

describe('a clean document', () => {
  test('extracts fully and refuses nothing', async () => {
    const result = await run('KBS-10234.pdf');

    expect(result.refusals).toEqual([]);
    expect(result.lineItems).toHaveLength(5);
    expect(result.documentTotal?.value).toBe(2630);
    expect(result.documentNumber?.value).toBe('KBS-10234');
  });
});

/**
 * None of the sample documents contains a line whose own arithmetic is wrong,
 * so this rule is exercised directly rather than through a fixture. Written
 * against hand-built line items to keep the case explicit.
 */
describe('a line that does not add up', () => {
  const line = (over: Partial<LineItem> = {}): LineItem => ({
    page: 2,
    lineNumber: 3,
    description: { value: 'Timber H3.2 90x45', evidence: { page: 2, sourceText: 'Timber H3.2 90x45' } },
    quantity: { value: 10, evidence: { page: 2, sourceText: '10' } },
    unit: { value: 'length', evidence: { page: 2, sourceText: 'length' } },
    unitPrice: { value: 18.4, evidence: { page: 2, sourceText: '$18.40' } },
    lineTotal: { value: 184, evidence: { page: 2, sourceText: '$184.00' } },
    ...over,
  });

  test('is flagged, quoting all three figures, with neither corrected', () => {
    const wrong = line({
      lineTotal: { value: 999, evidence: { page: 2, sourceText: '$999.00' } },
    });

    const [refusal] = lineArithmeticRefusals([wrong]);
    expect(refusal.code).toBe('LINE_ARITHMETIC_MISMATCH');
    expect(refusal.page).toBe(2);
    expect(refusal.lineNumber).toBe(3);
    expect(refusal.humanMessage).toContain('$184.00');
    expect(refusal.humanMessage).toContain('$999.00');
    expect(refusal.evidence.map((e) => e.sourceText)).toEqual(['10', '$18.40', '$999.00']);

    // The printed value is left exactly as it was read.
    expect(wrong.lineTotal!.value).toBe(999);
  });

  test('accepts a line that is correct', () => {
    expect(lineArithmeticRefusals([line()])).toEqual([]);
  });

  test('tolerates a rounding difference of one cent', () => {
    const rounded = line({
      quantity: { value: 3, evidence: { page: 2, sourceText: '3' } },
      unitPrice: { value: 0.335, evidence: { page: 2, sourceText: '$0.335' } },
      lineTotal: { value: 1.0, evidence: { page: 2, sourceText: '$1.00' } },
    });
    expect(lineArithmeticRefusals([rounded])).toEqual([]);
  });

  test('says nothing when a figure needed for the check is missing', () => {
    expect(lineArithmeticRefusals([line({ lineTotal: null })])).toEqual([]);
    expect(lineArithmeticRefusals([line({ unitPrice: null })])).toEqual([]);
  });
});

describe('the traceability rule', () => {
  test.each([
    'KBS-10234.pdf',
    'KBS-10241.pdf',
    'KBS-10255.pdf',
    'KBS-10262.pdf',
    'KBS-10270.pdf',
    'KBS-DR118.pdf',
  ])('every number in %s quotes text that is really on that page', async (name) => {
    const result = await run(name);
    const pages = await readPages(bytes(name));

    const textByPage = new Map(
      pages.map((p) => [p.page, new Set(p.cells.map((c) => c.text))]),
    );

    for (const number of tracedNumbers(result)) {
      const onPage = textByPage.get(number.page);
      expect(onPage, `${number.where} cites page ${number.page}, which does not exist`).toBeDefined();
      expect(
        onPage!.has(number.sourceText),
        `${number.where} cites "${number.sourceText}" on page ${number.page}, ` +
          `but no such text is printed there`,
      ).toBe(true);
    }
  });

  test.each([
    'KBS-10255.pdf',
    'KBS-10262.pdf',
    'KBS-10270.pdf',
    'KBS-DR118.pdf',
  ])('every refusal in %s quotes text that is really on that page', async (name) => {
    const result = await run(name);
    const pages = await readPages(bytes(name));

    const textByPage = new Map(
      pages.map((p) => [p.page, new Set(p.cells.map((c) => c.text))]),
    );

    for (const refusal of result.refusals) {
      for (const e of refusal.evidence) {
        expect(
          textByPage.get(e.page)?.has(e.sourceText),
          `${refusal.code} quotes "${e.sourceText}" on page ${e.page}, ` +
            `but no such text is printed there`,
        ).toBe(true);
      }
    }
  });
});

describe('every refusal', () => {
  test.each([
    'KBS-10241.pdf',
    'KBS-10255.pdf',
    'KBS-10262.pdf',
    'KBS-10270.pdf',
    'KBS-DR118.pdf',
  ])('carries a plain-language explanation in %s', async (name) => {
    const result = await run(name);
    expect(result.refusals.length).toBeGreaterThan(0);

    for (const refusal of result.refusals) {
      // Long enough to be a real sentence, and free of the codes and jargon
      // that a generic error handler would leave behind.
      expect(refusal.humanMessage.length).toBeGreaterThan(40);
      expect(refusal.humanMessage).not.toMatch(/undefined|null|NaN|\[object/);
      expect(refusal.humanMessage).not.toMatch(/something went wrong/i);
      expect(refusal.humanMessage).not.toContain(refusal.code);
    }
  });
});
