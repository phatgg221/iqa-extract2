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

  test('still refuses a document total once the eighth page is readable', async () => {
    const result = await extract(bytes('KBS-DR118.pdf'), 'KBS-DR118.pdf', {
      ocr: tesseractOcr(),
    });

    // Reading page 4 makes the naive sum *more* plausible, not less: all eight
    // pages now carry an identical $669.00, so 8 x 669 = $5,352.00 is the
    // tempting wrong answer. It is wrong because page 5 is a summary, pages 6
    // and 7 are a returns note and a credit adjustment, and page 8 is a
    // signed acceptance. None of that changes because a page became readable.
    expect(result.documentTotal).toBeNull();
    expect(JSON.stringify(result)).not.toContain('5352');

    const codes = result.refusals.map((r) => r.code);
    expect(codes).toContain('DOCUMENT_TOTAL_ABSENT');
    expect(codes).toContain('POSSIBLE_DUPLICATE_PAGE');
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

describe('an OCR engine that never starts', () => {
  test('becomes a refusal on that page, not a job that hangs forever', async () => {
    // The real failure, reproduced: in a serverless runtime `createWorker`
    // never returns, so the call that hangs is starting the engine rather than
    // reading the page. The first version of the timeout awaited the engine
    // *before* arming the clock, so a deployed job sat in `processing` for
    // five minutes with a 60s timeout that had not started yet.
    const neverStarts = () => new Promise<never>(() => {});

    const result = await extract(bytes('KBS-DR118.pdf'), 'KBS-DR118.pdf', {
      ocr: async () => {
        // Bounded here so the test cannot hang if the guard regresses; in the
        // engine the same shape is a 60s race around worker creation.
        return Promise.race([
          neverStarts(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('OCR did not finish within 60s')), 50),
          ),
        ]);
      },
    });

    // The page is refused with the reason, and the rest of the document is
    // unaffected — a stalled engine costs one page, not the job.
    const refusal = result.refusals.find((r) => r.code === 'NO_TEXT_LAYER')!;
    expect(refusal.humanMessage).toMatch(/did try to read it from the image/i);
    expect(refusal.humanMessage).toContain('did not finish within 60s');
    expect(result.lineItems).toHaveLength(21);
  }, 60000);
});

describe('the refusal on a page we could not read', () => {
  test('says OCR is not switched on, when it is not', async () => {
    const result = await extract(bytes('KBS-DR118.pdf'), 'KBS-DR118.pdf');
    const refusal = result.refusals.find((r) => r.code === 'NO_TEXT_LAYER')!;

    // "This page is a scan" is true but is not a reason anyone can act on.
    expect(refusal.humanMessage).toMatch(/OCR, which is not switched on/i);
  });

  test('says OCR was tried, when it was', async () => {
    // A rasterizer that always fails, so OCR is attempted and reports why.
    const result = await extract(bytes('KBS-DR118.pdf'), 'KBS-DR118.pdf', {
      ocr: async () => {
        throw new Error('the engine fell over');
      },
    });
    const refusal = result.refusals.find((r) => r.code === 'NO_TEXT_LAYER')!;

    expect(refusal.humanMessage).toMatch(/did try to read it from the image/i);
    expect(refusal.humanMessage).toContain('the engine fell over');
    expect(refusal.humanMessage).not.toMatch(/not switched on/i);

    // And the failure stays contained to that page.
    expect(result.lineItems).toHaveLength(21);
  }, 60000);
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
