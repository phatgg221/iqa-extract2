import type { RefusalCode } from './extract/types';

/**
 * Short headings for refusals.
 *
 * These are titles only. The explanation always comes from the refusal's own
 * `humanMessage`, which is written where the problem was found and passed
 * through untouched - the UI is not allowed to summarise or replace it.
 */
export const REFUSAL_TITLES: Record<RefusalCode, string> = {
  NO_TEXT_LAYER: 'This page is a scan we cannot read',
  PAGE_PARSE_FAILED: 'This page could not be processed',
  NO_TABLE_FOUND: 'No list of items found on this page',
  VALUE_NOT_PRINTED: 'The document does not print this figure',
  UNPARSEABLE_VALUE: 'This value is not a plain number',
  LINE_ARITHMETIC_MISMATCH: 'This line does not add up',
  DOCUMENT_TOTAL_MISMATCH: 'The total does not match the lines',
  DOCUMENT_TOTAL_ABSENT: 'No overall total is being reported',
  CONTRADICTORY_STATEMENT: 'The document contradicts itself',
  AMBIGUOUS_UNIT_SEMANTICS: 'A column does not mean the same thing throughout',
  SIGN_UNDETERMINED: 'Unclear whether these amounts add or subtract',
  POSSIBLE_DUPLICATE_PAGE: 'These pages may be the same figures twice',
};

export function money(amount: number): string {
  return amount.toLocaleString('en-NZ', {
    style: 'currency',
    currency: 'NZD',
    currencyDisplay: 'narrowSymbol',
  });
}
