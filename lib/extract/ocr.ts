/**
 * Reading a scanned page with OCR.
 *
 * The point of this file is to produce exactly the same `TextCell` shape the
 * text-layer reader produces, so the positional table parser works on a scan
 * without knowing it is one. Tesseract gives a bounding box and a confidence
 * for every word; those map straight onto page coordinates, and from there the
 * existing column-band logic does the rest.
 *
 * What comes out is still evidence — a page, a verbatim string, a position —
 * but evidence of a *reading of pixels* rather than of the file. Every cell is
 * tagged `source: 'ocr'` and carries its confidence so the layers above can
 * refuse the weak ones and the screen can say which figures were guessed at.
 */

import os from 'node:os';
import { createWorker, type Worker } from 'tesseract.js';
import { encodeGrayPng } from './png';
import type { OcrFn, PageRaster, TextCell } from './pdf';

/**
 * A floor for obvious noise only — specks, scan edges, marks the engine turns
 * into stray punctuation.
 *
 * Deliberately low. Dropping a word because it read poorly is itself a way of
 * hiding something, and it caused a real bug: the "Qty" and "Unit" headings on
 * the sample scan come back at 59 and 52 because each one absorbs the dotted
 * rule beneath it, so a 60 floor silently removed two whole columns and the
 * values under them were mapped to the wrong fields. Whether a *figure* is
 * trustworthy is decided later, by TRUSTED_OCR_CONFIDENCE in rules.ts, where
 * the answer can be reported instead of swallowed.
 */
export const MIN_WORD_CONFIDENCE = 30;

/**
 * Horizontal gap, as a multiple of the line's median character width, that
 * separates one column from the next. Tesseract reports words; a table cell is
 * a run of words with ordinary spaces between them, and a column break is a
 * visibly bigger gap than that.
 *
 * Measured on the sample scan: gaps inside a phrase run 0.37-0.92, real column
 * breaks on data rows run 5.1-33.7, and the tightest genuine break in the
 * header ("Qty" to "Unit") is 2.02. 1.4 sits clear of both sides.
 */
const COLUMN_GAP_RATIO = 1.4;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface OcrWord {
  text: string;
  confidence: number;
  bbox: Box;
}

let shared: Promise<Worker> | null = null;

/**
 * One worker per process; spinning one up costs seconds and a language download.
 *
 * `cachePath` matters more than it looks. Tesseract caches the downloaded
 * `eng.traineddata` at `cachePath || '.'`, and on a serverless host the working
 * directory is read-only — so the default sends a ~15 MB write at a filesystem
 * that will refuse it. The system temp directory is the one place guaranteed
 * writable, and it is correct locally too.
 */
function worker(): Promise<Worker> {
  shared ??= createWorker('eng', 1, { cachePath: os.tmpdir() });
  return shared;
}

export async function shutdownOcr(): Promise<void> {
  if (!shared) return;
  const w = await shared;
  shared = null;
  await w.terminate();
}

/**
 * Groups words into lines, then splits each line into cells wherever the gap
 * between words is wider than ordinary word spacing.
 */
function wordsToCells(words: OcrWord[], raster: PageRaster): TextCell[] {
  const usable = words.filter(
    (w) => w.text.trim().length > 0 && w.confidence >= MIN_WORD_CONFIDENCE,
  );
  if (usable.length === 0) return [];

  // Group into lines by vertical overlap of the boxes.
  const lines: OcrWord[][] = [];
  for (const word of [...usable].sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    const height = word.bbox.y1 - word.bbox.y0;
    const line = lines.find((l) => {
      const ref = l[0].bbox;
      return Math.abs((ref.y0 + ref.y1) / 2 - (word.bbox.y0 + word.bbox.y1) / 2) < height * 0.6;
    });
    if (line) line.push(word);
    else lines.push([word]);
  }

  const scaleX = raster.pageWidth / raster.width;
  const scaleY = raster.pageHeight / raster.height;
  const cells: TextCell[] = [];

  for (const line of lines) {
    line.sort((a, b) => a.bbox.x0 - b.bbox.x0);

    // Typical character width on this line, used to judge what counts as a gap.
    const charWidth =
      line.reduce((sum, w) => sum + (w.bbox.x1 - w.bbox.x0) / Math.max(1, w.text.length), 0) /
      line.length;
    const columnGap = charWidth * COLUMN_GAP_RATIO;

    // One baseline for the whole line, taken as the median so a single
    // oversized box cannot drag it.
    //
    // Per-cell baselines were wrong in a way that quietly broke everything
    // downstream: OCR boxes wobble a few points, so cells from one visual row
    // arrived with different y values and the row grouper split the header
    // across three rows, losing the Unit Price and Line Total columns. Text
    // read from a file has exact baselines; OCR has to be given them.
    const bottoms = line.map((w) => w.bbox.y1).sort((a, b) => a - b);
    const baseline = bottoms[Math.floor(bottoms.length / 2)];
    // Image y grows downward from the top; PDF y grows upward from the bottom.
    const pdfY = raster.pageHeight - baseline * scaleY;

    let run: OcrWord[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const first = run[0];
      cells.push({
        text: run.map((w) => w.text).join(' '),
        x: first.bbox.x0 * scaleX,
        y: pdfY,
        source: 'ocr',
        confidence: Math.round(Math.min(...run.map((w) => w.confidence))),
        words: run.map((w) => ({ text: w.text, x: w.bbox.x0 * scaleX })),
      });
      run = [];
    };

    for (const word of line) {
      if (run.length > 0 && word.bbox.x0 - run[run.length - 1].bbox.x1 > columnGap) flush();
      run.push(word);
    }
    flush();
  }

  return cells;
}

/** Collects the word list out of tesseract's nested block/paragraph/line tree. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectWords(data: any): OcrWord[] {
  if (Array.isArray(data?.words) && data.words.length > 0) return data.words as OcrWord[];

  const out: OcrWord[] = [];
  for (const block of data?.blocks ?? []) {
    for (const para of block?.paragraphs ?? []) {
      for (const line of para?.lines ?? []) {
        for (const word of line?.words ?? []) out.push(word as OcrWord);
      }
    }
  }
  return out;
}

/**
 * How long one page gets. Reading a page takes about a second; anything near
 * this means the engine is not coming back.
 *
 * This bound exists because of a real failure: tesseract spawns a worker
 * thread, which never starts inside a Next.js route handler, so the call hung
 * and left the job sitting in `processing` until the stalled-job sweep caught
 * it ten minutes later. A page we cannot read in time is a refusal, not a hang.
 */
const PAGE_TIMEOUT_MS = 60_000;

/**
 * The `OcrFn` to hand to `readPages({ ocr })`.
 *
 * Kept as a factory so nothing imports tesseract unless a caller actually
 * wants OCR — the synchronous route and the unit tests never load it.
 */
export function tesseractOcr(): OcrFn {
  return async (raster: PageRaster): Promise<TextCell[]> => {
    const png = encodeGrayPng(raster.width, raster.height, raster.gray);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`OCR did not finish within ${PAGE_TIMEOUT_MS / 1000}s`)),
        PAGE_TIMEOUT_MS,
      );
    });

    // Starting the engine is inside the race, not before it.
    //
    // The first version awaited `worker()` on the line above and only raced
    // the recognition, which bounded the wrong half: `createWorker` is what
    // spawns the worker thread, and that is the call that never returns in a
    // serverless runtime. A deployed job sat in `processing` for five minutes
    // with a 60s timeout armed that had not started yet.
    const read = (async () => {
      const w = await worker();
      const { data } = await w.recognize(png, {}, { blocks: true });
      return wordsToCells(collectWords(data), raster);
    })();

    try {
      return await Promise.race([read, timeout]);
    } catch (err) {
      // A pending `createWorker` stays cached and would hang every later page
      // too. Dropping it means the next page gets a fresh attempt rather than
      // awaiting a promise that will never settle.
      shared = null;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

export { wordsToCells as __wordsToCellsForTests };
