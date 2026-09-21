/**
 * Positioned cells -> a structured page.
 *
 * Column boundaries are derived from the header row on each page rather than
 * hardcoded, because the sample documents genuinely differ: most print
 * "Qty | Unit | Unit Price | Line Total" while the packing list with weights
 * prints "Qty | Weight | Unit Price" and no line totals at all. Reading the
 * header is what lets the same parser handle both without a special case.
 */

import { groupIntoRows, rowText, type RawPage, type Row, type TextCell } from './pdf';
import { parseMoney, parseMoneyWithUnit, parseQuantity, parseTrailingMoney } from './money';

export type ColumnKey =
  | 'item'
  | 'description'
  | 'qty'
  | 'unit'
  | 'weight'
  | 'unitPrice'
  | 'lineTotal';

const HEADER_LABELS: Record<string, ColumnKey> = {
  item: 'item',
  description: 'description',
  qty: 'qty',
  quantity: 'qty',
  unit: 'unit',
  weight: 'weight',
  'unit price': 'unitPrice',
  'line total': 'lineTotal',
};

/** How far left of a column's x origin a cell may start and still belong to it. */
const COLUMN_SNAP = 3;

interface Column {
  key: ColumnKey;
  x: number;
}

/** A line-item row, with each cell kept alongside the column it landed in. */
export interface ParsedRow {
  lineNumber: number;
  cells: Partial<Record<ColumnKey, TextCell>>;
}

export interface ParsedPage {
  page: number;
  /** Empty when the page carries no text layer at all. */
  hasText: boolean;
  /** Whether OCR was available and tried on this page, and what it hit. */
  ocrAttempted: boolean;
  ocrProblem: string | null;
  /** False when text exists but no line-item header could be found. */
  hasTable: boolean;
  title: TextCell | null;
  documentNumber: { cell: TextCell; value: string } | null;
  documentDate: { cell: TextCell; value: string } | null;
  columns: Column[];
  /** The header row's cells, kept so refusals about columns can quote the page. */
  headerCells: TextCell[];
  rows: ParsedRow[];
  /** The totals row's amount cell, when the page prints a total. */
  statedTotal: { cell: TextCell; value: number } | null;
  /**
   * True when a row begins with "Total" but carries no money amount, e.g.
   * "Total consignment weight: see individual lines." Distinguishing this
   * from "no totals row at all" lets us explain the refusal precisely.
   */
  totalRowWithoutAmount: TextCell | null;
  /** Free-text lines outside the table, kept for contradiction checks. */
  prose: TextCell[];
}

const SEPARATOR = /^-{4,}$/;
const DOC_NO = /^Document No:\s*(.+)$/i;
const DATE = /^Date:\s*(.+)$/i;
const TOTAL_ROW = /^total\b/i;

function isSeparator(row: Row): boolean {
  return row.cells.every((c) => SEPARATOR.test(c.text));
}

function findHeader(rows: Row[]): { row: Row; index: number } | null {
  for (let i = 0; i < rows.length; i++) {
    // Matched against the whole row rather than individual cells, because OCR
    // can run two labels together: "Item" and "Description" sit closer on the
    // page than the words inside a phrase do, so no spacing rule separates them.
    const line = rows[i].cells.map((c) => c.text.toLowerCase()).join(' ');
    if (/\bitem\b/.test(line) && /\bdescription\b/.test(line)) {
      return { row: rows[i], index: i };
    }
  }
  return null;
}

/**
 * Finds the labels inside a cell whose text ran several of them together,
 * using the per-word positions OCR keeps, so each column still gets its own
 * true origin instead of an estimate.
 */
function columnsWithinCell(cell: TextCell): Column[] {
  if (!cell.words || cell.words.length < 2) return [];

  const found: Column[] = [];
  const words = cell.words;

  for (let i = 0; i < words.length; i++) {
    // Two-word labels first ("Unit Price"), so "Unit" does not claim the pair.
    const pair = i + 1 < words.length ? `${words[i].text} ${words[i + 1].text}` : null;
    const pairKey = pair ? HEADER_LABELS[pair.toLowerCase()] : undefined;
    if (pairKey) {
      found.push({ key: pairKey, x: words[i].x });
      i++;
      continue;
    }
    const key = HEADER_LABELS[words[i].text.toLowerCase()];
    if (key) found.push({ key, x: words[i].x });
  }

  return found;
}

function buildColumns(header: Row): Column[] {
  const columns: Column[] = [];

  for (const cell of header.cells) {
    const key = HEADER_LABELS[cell.text.toLowerCase()];
    if (key) {
      columns.push({ key, x: cell.x });
      continue;
    }
    columns.push(...columnsWithinCell(cell));
  }

  // Keep the leftmost origin for any label that turned up more than once.
  const byKey = new Map<ColumnKey, Column>();
  for (const column of columns) {
    const seen = byKey.get(column.key);
    if (!seen || column.x < seen.x) byKey.set(column.key, column);
  }

  return [...byKey.values()].sort((a, b) => a.x - b.x);
}

/** Cells are left-aligned on their column, so the nearest origin at or left of the cell wins. */
function columnFor(cell: TextCell, columns: Column[]): ColumnKey | null {
  let match: Column | null = null;
  for (const column of columns) {
    if (cell.x >= column.x - COLUMN_SNAP && (!match || column.x > match.x)) {
      match = column;
    }
  }
  return match?.key ?? null;
}

export function parsePage(raw: RawPage): ParsedPage {
  const base: ParsedPage = {
    page: raw.page,
    hasText: raw.cells.length > 0,
    ocrAttempted: raw.ocrAttempted ?? false,
    ocrProblem: raw.ocrProblem ?? null,
    hasTable: false,
    title: null,
    documentNumber: null,
    documentDate: null,
    columns: [],
    headerCells: [],
    rows: [],
    statedTotal: null,
    totalRowWithoutAmount: null,
    prose: [],
  };

  if (raw.cells.length === 0) return base;

  const rows = groupIntoRows(raw.cells).filter((r) => !isSeparator(r));

  // The sub-heading sits directly under the company name and is how a page
  // announces itself as a summary, a returns note or a credit adjustment.
  if (rows.length > 1 && rows[1].cells.length === 1) {
    base.title = rows[1].cells[0];
  }

  for (const row of rows) {
    for (const cell of row.cells) {
      const docNo = DOC_NO.exec(cell.text);
      if (docNo) base.documentNumber = { cell, value: docNo[1].trim() };
      const date = DATE.exec(cell.text);
      if (date) base.documentDate = { cell, value: date[1].trim() };
    }
  }

  const header = findHeader(rows);
  if (!header) {
    base.prose = rows.flatMap((r) => r.cells);
    return base;
  }

  base.hasTable = true;
  base.columns = buildColumns(header.row);
  base.headerCells = header.row.cells;

  const body = rows.slice(header.index + 1);
  const consumed = new Set<Row>();

  for (const row of body) {
    const cells: Partial<Record<ColumnKey, TextCell>> = {};
    for (const cell of row.cells) {
      const key = columnFor(cell, base.columns);
      if (key && !cells[key]) cells[key] = cell;
    }

    const itemText = cells.item?.text ?? '';
    const lineNumber = /^\d+$/.test(itemText) ? Number(itemText) : null;

    if (lineNumber !== null && cells.description) {
      base.rows.push({ lineNumber, cells });
      consumed.add(row);
      continue;
    }

    // Totals rows come in two shapes across these documents: a "Total:" label
    // with the amount in the Line Total column, and a single cell that carries
    // the amount inline ("Total: $5,122.40"). Both must be recognised.
    const first = row.cells[0];
    if (first && TOTAL_ROW.test(first.text)) {
      const inline = parseTrailingMoney(first.text);
      if (inline !== null) {
        base.statedTotal = { cell: first, value: inline };
        consumed.add(row);
        continue;
      }
      const amountCell = row.cells
        .slice(1)
        .find((c) => parseMoney(c.text) !== null);
      if (amountCell) {
        base.statedTotal = { cell: amountCell, value: parseMoney(amountCell.text)! };
        consumed.add(row);
        continue;
      }
      // A totals row with nothing numeric on it, e.g. a weight consignment
      // note that defers to the individual lines.
      base.totalRowWithoutAmount = first;
      consumed.add(row);
    }
  }

  base.prose = rows
    .filter((r) => r !== header.row && !consumed.has(r))
    .flatMap((r) => r.cells);

  return base;
}

/** Reads a row's scalar cells, returning nulls rather than guesses. */
export function readRow(row: ParsedRow) {
  const { cells } = row;

  const quantity = cells.qty ? parseQuantity(cells.qty.text) : null;
  const lineTotal = cells.lineTotal ? parseMoney(cells.lineTotal.text) : null;

  // The price cell may carry the unit inline ("$68.00 /bag") on documents
  // that have no Unit column of their own.
  let unitPrice: number | null = null;
  let unitFromPrice: string | null = null;
  if (cells.unitPrice) {
    const plain = parseMoney(cells.unitPrice.text);
    if (plain !== null) {
      unitPrice = plain;
    } else {
      const withUnit = parseMoneyWithUnit(cells.unitPrice.text);
      if (withUnit) {
        unitPrice = withUnit.amount;
        unitFromPrice = withUnit.unit;
      }
    }
  }

  return { quantity, unitPrice, unitFromPrice, lineTotal };
}

export { rowText };
