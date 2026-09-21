/**
 * Strict scalar parsing.
 *
 * These parsers are deliberately unforgiving. A cell either is a clean number
 * or it is not one, and "not one" is a useful answer. Being lenient here is
 * how a weight ("480g total") quietly becomes a quantity.
 *
 * All money comparisons happen in integer cents. Comparing dollars as floats
 * makes 1195.2 !== 1195.2000000000003 and invents mismatches that are not
 * really in the document.
 */

/** e.g. "$1,195.20" or "1195.2" - currency symbol and thousands separators optional. */
const MONEY = /^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/;

/** e.g. "48" or "1.5" - a bare count. No units, no words, no ranges. */
const QUANTITY = /^(\d+(?:\.\d+)?)$/;

/** Money with a trailing per-unit marker, e.g. "$68.00 /bag", "$0.09 /ea". */
const MONEY_WITH_UNIT = /^(\$?\s*(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d{1,2})?)\s*\/\s*([A-Za-z]+)$/;

/** Money embedded at the end of a label, e.g. "Total: $5,122.40". */
const TRAILING_MONEY = /\$\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/;

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/** Parses a standalone money cell. Returns null rather than guessing. */
export function parseMoney(raw: string): number | null {
  const m = MONEY.exec(raw.trim());
  if (!m) return null;
  const whole = m[1].replace(/,/g, '');
  const frac = (m[2] ?? '').padEnd(2, '0');
  return Number(`${whole}.${frac}`);
}

/** Parses a bare count. Rejects anything carrying a unit or a word. */
export function parseQuantity(raw: string): number | null {
  const m = QUANTITY.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Splits a price cell that carries its unit inline, e.g. "$68.00 /bag".
 * Used where the document has no separate Unit column, so the unit is only
 * recoverable from the price string itself.
 */
export function parseMoneyWithUnit(
  raw: string,
): { amount: number; unit: string } | null {
  const m = MONEY_WITH_UNIT.exec(raw.trim());
  if (!m) return null;
  const amount = parseMoney(m[1]);
  return amount === null ? null : { amount, unit: m[2] };
}

/**
 * Pulls a money amount off the end of a label cell, e.g. "Total: $5,122.40".
 * Only used on rows we have already identified as totals rows.
 */
export function parseTrailingMoney(raw: string): number | null {
  const m = TRAILING_MONEY.exec(raw.trim());
  if (!m) return null;
  const whole = m[1].replace(/,/g, '');
  const frac = (m[2] ?? '').padEnd(2, '0');
  return Number(`${whole}.${frac}`);
}

/** Formats for humanMessage text. Presentation only; never re-parsed. */
export function formatMoney(amount: number): string {
  return `$${amount.toLocaleString('en-NZ', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
