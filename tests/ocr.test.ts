/**
 * Tests for reading a scanned page.
 *
 * The thing being pinned here is not "OCR works" — it is that a figure read
 * off pixels is never mistaken for a figure read out of the file. Every value
 * OCR produces has to arrive labelled as a guess, with a confidence, and the
 * moment OCR is switched off the page must go back to being refused.
 */

import { afterAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extract } from '@/lib/extract/extract';
import {
  shutdownOcr,
  tesseractOcr,
  __wordsToCellsForTests as wordsToCells,
} from '@/lib/extract/ocr';
import { ocrConfidenceRefusals, TRUSTED_OCR_CONFIDENCE } from '@/lib/extract/rules';
import type { LineItem } from '@/lib/extract/types';

const SAMPLES = path.resolve(__dirname, '../samples');
const bytes = (n: string) => new Uint8Array(fs.readFileSync(path.join(SAMPLES, n)));

afterAll(async () => {
  await shutdownOcr();
});

describe('a scanned page, with OCR switched off', () => {
  test('is still refused — the default is to read the file, not the pixels', async () => {
    const result = await extract(bytes('KBS-DR118.pdf'), 'KBS-DR118.pdf');

    expect(result.pages.find((p) => p.page === 4)!.extracted).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain('NO_TEXT_LAYER');
    expect(result.lineItems).toHaveLength(21);
  });
});

describe('a scanned page, with OCR switched on', () => {
  test('is read, and every figure is labelled as coming from OCR', async () => {
    const result = await extract(bytes('KBS-DR118.pdf'), 'KBS-DR118.pdf', {
      ocr: tesseractOcr(),
    });

    const page4 = result.pages.find((p) => p.page === 4)!;
    expect(page4.extracted).toBe(true);
    expect(page4.lineItems).toHaveLength(3);

    // The three pages either side are unaffected, so the document goes from
    // 21 line items to 24 rather than being re-read differently.
    expect(result.lineItems).toHaveLength(24);

    for (const item of page4.lineItems) {
      for (const traced of [item.quantity, item.unitPrice, item.lineTotal]) {
        expect(traced).not.toBeNull();
        expect(traced!.evidence.source).toBe('ocr');
        expect(traced!.evidence.confidence).toBeGreaterThan(0);
      }
    }

    // ...and nothing on the other pages is mislabelled as a guess.
    for (const item of result.lineItems.filter((i) => i.page !== 4)) {
      expect(item.description.evidence.source).toBe('text-layer');
      expect(item.description.evidence.confidence).toBeUndefined();
    }
  }, 120000);

  test('reads the figures that are actually printed on the page', async () => {
    const result = await extract(bytes('KBS-DR118.pdf'), 'KBS-DR118.pdf', {
      ocr: tesseractOcr(),
    });
    const page4 = result.pages.find((p) => p.page === 4)!;

    // Page 4 of this document reads 10 / 13 / 16 at $16 / $17 / $18.
    expect(page4.lineItems.map((i) => i.quantity?.value)).toEqual([10, 13, 16]);
    expect(page4.lineItems.map((i) => i.unitPrice?.value)).toEqual([16, 17, 18]);
    expect(page4.lineItems.map((i) => i.lineTotal?.value)).toEqual([160, 221, 288]);

    // Each line still adds up, so the arithmetic rule stays quiet — an OCR
    // misread would usually break this, which makes it a useful canary.
    expect(result.refusals.filter((r) => r.code === 'LINE_ARITHMETIC_MISMATCH')).toEqual([]);
  }, 120000);

  test('quotes what OCR saw, not what we wish it saw', async () => {
    const result = await extract(bytes('KBS-DR118.pdf'), 'KBS-DR118.pdf', {
      ocr: tesseractOcr(),
    });
    const first = result.pages.find((p) => p.page === 4)!.lineItems[0];

    expect(first.lineTotal!.evidence).toMatchObject({
      page: 4,
      sourceText: '$160.00',
      source: 'ocr',
    });
  }, 120000);
});

describe('a figure OCR was unsure about', () => {
  const traced = (value: number, confidence: number) => ({
    value,
    evidence: { page: 4, sourceText: `$${value}`, source: 'ocr' as const, confidence },
  });

  const item = (confidence: number): LineItem => ({
    page: 4,
    lineNumber: 2,
    description: {
      value: 'Framing timber',
      evidence: { page: 4, sourceText: 'Framing timber', source: 'ocr', confidence: 95 },
    },
    quantity: traced(13, 95),
    unit: null,
    unitPrice: traced(17, confidence),
    lineTotal: traced(221, 95),
  });

  test('is reported, but flagged rather than quietly trusted', () => {
    const [refusal] = ocrConfidenceRefusals([item(41)]);

    expect(refusal.code).toBe('LOW_OCR_CONFIDENCE');
    expect(refusal.page).toBe(4);
    expect(refusal.humanMessage).toContain('41%');
    expect(refusal.humanMessage).toMatch(/line 2 unit price/);
    // The value is not dropped — it is printed on the page, and hiding our
    // best reading of it would be its own kind of dishonesty.
    expect(item(41).unitPrice!.value).toBe(17);
  });

  test('passes without comment once it is read clearly enough', () => {
    expect(ocrConfidenceRefusals([item(TRUSTED_OCR_CONFIDENCE)])).toEqual([]);
  });

  test('never flags a figure that came from the file itself', () => {
    const fromFile: LineItem = {
      ...item(10),
      unitPrice: {
        value: 17,
        evidence: { page: 4, sourceText: '$17.00', source: 'text-layer' },
      },
    };
    expect(ocrConfidenceRefusals([fromFile])).toEqual([]);
  });
});

describe('grouping OCR words into cells', () => {
  const raster = { gray: new Uint8Array(0), width: 1000, height: 1000, pageWidth: 1000, pageHeight: 1000 };
  const word = (text: string, x0: number, x1: number, confidence = 95) => ({
    text,
    confidence,
    bbox: { x0, y0: 100, x1, y1: 120 },
  });

  test('keeps words of one phrase together and splits at a column gap', () => {
    // "Framing timber" with ordinary spacing, then a wide gap, then a figure.
    const cells = wordsToCells(
      [word('Framing', 0, 70), word('timber', 78, 130), word('$160.00', 400, 460)],
      raster,
    );

    expect(cells.map((c) => c.text)).toEqual(['Framing timber', '$160.00']);
  });

  test('gives every cell on a line the same baseline', () => {
    const cells = wordsToCells(
      [word('Qty', 0, 40), word('Unit', 300, 350), word('Price', 600, 660)],
      raster,
    );
    expect(new Set(cells.map((c) => c.y)).size).toBe(1);
  });

  test('takes a cell confidence from its least certain word', () => {
    const [cell] = wordsToCells([word('Framing', 0, 70, 91), word('timber', 78, 130, 64)], raster);
    expect(cell.confidence).toBe(64);
  });

  test('drops only obvious noise, not merely imperfect readings', () => {
    // 52 is what "Unit" actually scores on the sample scan, because the
    // heading absorbs the dotted rule beneath it. Dropping it removed a whole
    // column and silently mapped values into the wrong fields.
    const cells = wordsToCells([word('Unit', 0, 40, 52), word('~', 300, 310, 4)], raster);
    expect(cells.map((c) => c.text)).toEqual(['Unit']);
  });
});
