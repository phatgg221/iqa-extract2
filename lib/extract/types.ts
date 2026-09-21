/**
 * Core contract for the extractor.
 *
 * The single rule this file exists to enforce in the type system:
 * every number we publish is wrapped in `Traced<T>`, which cannot be
 * constructed without the page and the verbatim source text it came from.
 * If we cannot point at a source, the field is `null` and a `Refusal`
 * explains why. There is deliberately no way to express "a number we
 * worked out ourselves".
 */

export type RefusalCode =
  /** Page has no text layer at all (a scan). We do not OCR, so we decline the page. */
  | 'NO_TEXT_LAYER'
  /** Page threw while parsing. Contained to the page; other pages still return. */
  | 'PAGE_PARSE_FAILED'
  /** Page has text but no recognisable line-item table. */
  | 'NO_TABLE_FOUND'
  /** The document simply does not print this value; we will not derive it. */
  | 'VALUE_NOT_PRINTED'
  /** A cell was present but did not parse as a clean number. */
  | 'UNPARSEABLE_VALUE'
  /** qty x unit price does not equal the printed line total. */
  | 'LINE_ARITHMETIC_MISMATCH'
  /** The printed document total does not equal the sum of printed line totals. */
  | 'DOCUMENT_TOTAL_MISMATCH'
  /** No document total is printed anywhere, and we will not sum one. */
  | 'DOCUMENT_TOTAL_ABSENT'
  /** Two statements in the document disagree with each other. */
  | 'CONTRADICTORY_STATEMENT'
  /** A column's meaning is not consistent down the page. */
  | 'AMBIGUOUS_UNIT_SEMANTICS'
  /** Amounts whose sign (add or subtract) the document never states. */
  | 'SIGN_UNDETERMINED'
  /** A page that may restate figures counted elsewhere. */
  | 'POSSIBLE_DUPLICATE_PAGE'
  /** Read by OCR, but not clearly enough to stand behind. */
  | 'LOW_OCR_CONFIDENCE';

export type RefusalScope = 'document' | 'page' | 'line' | 'field';

/**
 * Where a value came from.
 *
 * `source` is part of the evidence, not a footnote on it. Text read out of the
 * file is a fact about the document; text read by OCR is a reading of pixels
 * that could be wrong, and the difference has to survive all the way to the
 * screen. There is deliberately no way to record a value without saying which
 * of the two it is.
 */
export interface Evidence {
  page: number;
  /** Copied verbatim off the page, or as OCR read it. */
  sourceText: string;
  source: 'text-layer' | 'ocr';
  /** 0-100. Present only for OCR. */
  confidence?: number;
}

/** A value that knows where it came from. The only way to publish a number. */
export interface Traced<T> {
  value: T;
  evidence: Evidence;
}

/**
 * Something we declined to extract, and why.
 *
 * `humanMessage` is written here, at the point the refusal is raised, because
 * this is the only place the context still exists. Later layers must pass it
 * through untouched rather than substituting a generic message.
 */
export interface Refusal {
  scope: RefusalScope;
  code: RefusalCode;
  page: number | null;
  lineNumber: number | null;
  field: string | null;
  humanMessage: string;
  evidence: Evidence[];
}

export interface LineItem {
  page: number;
  /** The number printed in the Item column, not our own index. */
  lineNumber: number;
  description: Traced<string>;
  quantity: Traced<number> | null;
  unit: Traced<string> | null;
  unitPrice: Traced<number> | null;
  /** Null when the document does not print a line total. Never computed. */
  lineTotal: Traced<number> | null;
}

export interface PageResult {
  page: number;
  /** The sub-heading under the company name, e.g. "Site 4 of 4 - Beach Road". */
  title: Traced<string> | null;
  lineItems: LineItem[];
  /** The total printed on this page, if one is printed. */
  statedTotal: Traced<number> | null;
  /** False when the page was refused outright (scan, parse failure, no table). */
  extracted: boolean;
}

export interface ExtractionResult {
  fileName: string;
  pageCount: number;
  documentNumber: Traced<string> | null;
  documentDate: Traced<string> | null;
  pages: PageResult[];
  /** Every line item across every page that we could read. */
  lineItems: LineItem[];
  /**
   * Only ever a total printed in the document and not contradicted.
   * Null means "we are not telling you a total" - see refusals for why.
   */
  documentTotal: Traced<number> | null;
  refusals: Refusal[];
}
