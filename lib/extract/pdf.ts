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

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface TextCell {
  text: string;
  /** Left edge, in PDF points from the left of the page. */
  x: number;
  /** Baseline, in PDF points from the bottom of the page (so higher = nearer the top). */
  y: number;
}

export interface RawPage {
  page: number;
  cells: TextCell[];
}

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
        cells.push({ text, x: item.transform[4], y: item.transform[5] });
      }

      pages.push({ page: n, cells });
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
