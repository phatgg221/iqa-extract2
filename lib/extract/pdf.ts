/**
 * PDF -> positioned text cells.
 *
 * This is the only module that knows pdfjs exists. Everything downstream
 * works on plain `TextCell`s, which keeps the parser testable without a PDF.
 *
 * pdfjs hands back each table cell as one text item anchored at its column's
 * x origin, so a cell's `text` is already exactly the string printed on the
 * page. That is what makes evidence exact rather than reconstructed.
 */

import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Where a cell's text came from. OCR is a reading of pixels, not of the file. */
export type CellSource = 'text-layer' | 'ocr';

export interface TextCell {
  text: string;
  /** Left edge, in PDF points from the left of the page. */
  x: number;
  /** Baseline, in PDF points from the bottom of the page (so higher = nearer the top). */
  y: number;
  source: CellSource;
  /** 0-100, OCR only. Absent means the text was read from the file itself. */
  confidence?: number;
  /**
   * OCR only: the individual words this cell was assembled from, with their
   * own positions. Needed because two header labels can sit closer together
   * than the words inside a phrase - "Item Description" is a single run by
   * any spacing rule - so the only way to recover their separate column
   * origins is to look inside the run.
   */
  words?: { text: string; x: number }[];
}

export interface RawPage {
  page: number;
  cells: TextCell[];
  /** Set when a page had no text layer and could not be OCR'd either. */
  ocrProblem?: string;
}

/** A page's pixels, ready to hand to an OCR engine. */
export interface PageRaster {
  /** Greyscale, one byte per pixel, width*height long. */
  gray: Uint8Array;
  width: number;
  height: number;
  /** The page's size in PDF points, for mapping boxes back into page space. */
  pageWidth: number;
  pageHeight: number;
}

/**
 * Reads pixels and returns positioned cells. Injected rather than imported so
 * that `lib/extract` stays free of the OCR engine: the core keeps working (and
 * testing) without it, and the sync route does not pay for it.
 */
export type OcrFn = (raster: PageRaster) => Promise<TextCell[]>;

/** Thrown when the bytes are not a PDF we can open at all. */
export class UnreadablePdfError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'UnreadablePdfError';
  }
}

export interface ReadOptions {
  /**
   * Called after each page is read. Reading the pages is the slow part of a
   * large document, so this is where progress has to come from if it is going
   * to mean anything.
   */
  onPage?: (pagesDone: number, pageCount: number) => void | Promise<void>;

  /**
   * Optional. When a page carries no text layer, hand its pixels to this and
   * use whatever it reads. Leave it out and such pages stay empty, which is
   * the original behaviour: refuse rather than guess.
   */
  ocr?: OcrFn;
}

interface DecodedImage {
  width: number;
  height: number;
  kind: number;
  data: Uint8Array | null;
}

/** Resolves a pdfjs object store entry, or gives up rather than waiting forever. */
function getObject(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: any,
  name: string,
  timeoutMs = 5000,
): Promise<DecodedImage | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: DecodedImage | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      store?.get(name, finish);
    } catch {
      finish(null);
    }
  });
}

/**
 * Pulls a scanned page's pixels out as greyscale.
 *
 * Only handles the case this is actually for: a page whose entire content is
 * one image covering it. A page composed of many images is not a scan of a
 * docket, and stitching them together to guess at a layout is the kind of
 * invention this service exists to avoid — so it returns a reason instead.
 */
async function rasterizePage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
): Promise<{ raster: PageRaster } | { problem: string }> {
  const viewport = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();

  const names: string[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (
      ops.fnArray[i] === OPS.paintImageXObject ||
      ops.fnArray[i] === OPS.paintImageXObjectRepeat
    ) {
      names.push(ops.argsArray[i][0]);
    }
  }

  if (names.length === 0) {
    return { problem: 'the page has neither text nor any image on it' };
  }
  if (names.length > 1) {
    return {
      problem:
        `the page is built from ${names.length} separate images rather than one scan, ` +
        `and piecing them together would mean guessing at the layout`,
    };
  }

  const name = names[0];

  // pdfjs resolves image objects through a callback that simply never fires if
  // the object lives in the other store, so every wait here is bounded. A step
  // that can hang forever would wedge the whole worker on one bad page, which
  // is a worse failure than refusing the page.
  const img =
    (await getObject(page.objs, name)) ?? (await getObject(page.commonObjs, name));

  if (!img?.data) {
    return { problem: 'the image on the page could not be decoded' };
  }

  const { width, height, kind, data } = img;
  const pixels = width * height;
  const gray = new Uint8Array(pixels);

  // pdfjs ImageKind: 1 = 1bpp greyscale, 2 = RGB 24bpp, 3 = RGBA 32bpp.
  if (kind === 2 && data.length >= pixels * 3) {
    for (let i = 0; i < pixels; i++) {
      gray[i] = (data[i * 3] * 77 + data[i * 3 + 1] * 150 + data[i * 3 + 2] * 29) >> 8;
    }
  } else if (kind === 3 && data.length >= pixels * 4) {
    for (let i = 0; i < pixels; i++) {
      gray[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
    }
  } else if (kind === 1) {
    // One bit per pixel, packed, and 1 means black in pdfjs' representation.
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        gray[y * width + x] = bit ? 0 : 255;
      }
    }
  } else if (data.length >= pixels) {
    gray.set(data.subarray(0, pixels));
  } else {
    return { problem: `the image uses a pixel format we cannot read (kind ${kind})` };
  }

  return {
    raster: {
      gray,
      width,
      height,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
    },
  };
}

export async function readPages(
  bytes: Uint8Array,
  options: ReadOptions = {},
): Promise<RawPage[]> {
  let pdf;
  try {
    pdf = await getDocument({
      data: bytes,
      useSystemFonts: true,
      // No worker in a server route; pdfjs falls back to running inline.
      isEvalSupported: false,
    }).promise;
  } catch (err) {
    throw new UnreadablePdfError(
      err instanceof Error ? err.message : 'The file could not be opened as a PDF.',
      err,
    );
  }

  const pages: RawPage[] = [];

  for (let n = 1; n <= pdf.numPages; n++) {
    // A single unreadable page must not take down the rest of the document,
    // so page-level failures become an empty cell list and are classified
    // as a refusal upstream rather than thrown.
    try {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const cells: TextCell[] = [];

      for (const item of content.items) {
        if (!('str' in item)) continue; // marked-content nodes carry no text
        const text = item.str.trim();
        if (!text) continue;
        cells.push({ text, x: item.transform[4], y: item.transform[5], source: 'text-layer' });
      }

      // No text layer. If OCR is available, read the pixels instead — and
      // record why if that is not possible either, so the refusal upstream can
      // say something more useful than "this page is a scan".
      if (cells.length === 0 && options.ocr) {
        const attempt = await rasterizePage(page);
        if ('problem' in attempt) {
          pages.push({ page: n, cells: [], ocrProblem: attempt.problem });
        } else {
          try {
            pages.push({ page: n, cells: await options.ocr(attempt.raster) });
          } catch (err) {
            pages.push({
              page: n,
              cells: [],
              ocrProblem: `reading the page by OCR failed (${
                err instanceof Error ? err.message : String(err)
              })`,
            });
          }
        }
      } else {
        pages.push({ page: n, cells });
      }
    } catch {
      pages.push({ page: n, cells: [] });
    }

    // Reported outside the try/catch so a refused page still counts as read.
    // Progress that stalls on the one page you cannot parse is worse than none.
    await options.onPage?.(n, pdf.numPages);
  }

  return pages;
}

/** Vertical tolerance, in points, for treating cells as being on the same row. */
const ROW_TOLERANCE = 2;

export interface Row {
  y: number;
  cells: TextCell[];
}

/** Groups cells into visual rows, ordered top of page first. */
export function groupIntoRows(cells: TextCell[]): Row[] {
  const rows: Row[] = [];

  for (const cell of [...cells].sort((a, b) => b.y - a.y)) {
    const row = rows.find((r) => Math.abs(r.y - cell.y) <= ROW_TOLERANCE);
    if (row) row.cells.push(cell);
    else rows.push({ y: cell.y, cells: [cell] });
  }

  for (const row of rows) row.cells.sort((a, b) => a.x - b.x);
  return rows;
}

/** The full text of a row, as a person reading the page would see it. */
export function rowText(row: Row): string {
  return row.cells.map((c) => c.text).join(' ');
}
