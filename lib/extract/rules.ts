/**
 * Refusal rules.
 *
 * Every rule in here reads what was parsed and, where something is missing or
 * disagrees with itself, produces a `Refusal` that explains it in the words a
 * person on a building site would use. No rule ever repairs a value or fills
 * a gap: arithmetic is used only to notice disagreement, never to supply an
 * answer the document does not contain.
 */

import type { Evidence, LineItem, Refusal } from './types';
import { formatMoney, toCents } from './money';
import type { ParsedPage } from './table';

export function ev(page: number, sourceText: string): Evidence {
  return { page, sourceText };
}

function refusal(r: Partial<Refusal> & Pick<Refusal, 'scope' | 'code' | 'humanMessage'>): Refusal {
  return {
    page: null,
    lineNumber: null,
    field: null,
    evidence: [],
    ...r,
  };
}

/** Pages that announce themselves as something other than a plain delivery. */
export function classifyPage(title: string | null) {
  const t = title ?? '';
  return {
    isSummary: /\bsummary\b/i.test(t),
    isReturn: /\breturns?\b/i.test(t),
    isCredit: /\bcredit\b|\badjustment\b/i.test(t),
  };
}

/* ---------------------------------------------------------------- page rules */

export function pageLevelRefusals(parsed: ParsedPage): Refusal[] {
  const out: Refusal[] = [];
  const page = parsed.page;

  if (!parsed.hasText) {
    out.push(
      refusal({
        scope: 'page',
        code: 'NO_TEXT_LAYER',
        page,
        humanMessage:
          `Page ${page} is a scanned image with no selectable text behind it. ` +
          `There may well be line items printed on it, but reading them would mean ` +
          `guessing at the pixels, so nothing from this page has been extracted. ` +
          `Check this page by eye.`,
        evidence: [],
      }),
    );
    return out;
  }

  if (!parsed.hasTable) {
    out.push(
      refusal({
        scope: 'page',
        code: 'NO_TABLE_FOUND',
        page,
        humanMessage:
          `Page ${page} has text on it but no line-item table we recognise, ` +
          `so no items have been taken from it.`,
        evidence: parsed.prose.slice(0, 2).map((c) => ev(page, c.text)),
      }),
    );
    return out;
  }

  const hasLineTotalColumn = parsed.columns.some((c) => c.key === 'lineTotal');
  if (!hasLineTotalColumn && parsed.rows.length > 0) {
    out.push(
      refusal({
        scope: 'page',
        code: 'VALUE_NOT_PRINTED',
        page,
        field: 'lineTotal',
        humanMessage:
          `Page ${page} does not print a line total for any of its items. ` +
          `Quantities and unit prices are shown below as printed, but the line ` +
          `totals have been left blank rather than multiplied out, because a ` +
          `calculated figure is not what the document says.`,
        evidence: parsed.headerCells.map((c) => ev(page, c.text)),
      }),
    );
  }

  out.push(...weightSemanticRefusals(parsed));
  out.push(...proseContradictionRefusals(parsed));

  return out;
}

/**
 * The weights packing list mixes per-unit and whole-line weights in one column:
 * "25kg" is the weight of one bag, but "480g total" covers all 1200 screws.
 * Nothing on the page marks which is which, so the column cannot be relied on.
 */
function weightSemanticRefusals(parsed: ParsedPage): Refusal[] {
  const weights = parsed.rows
    .map((r) => r.cells.weight)
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  if (weights.length < 2) return [];

  const aggregate = weights.filter((c) => /\btotal\b/i.test(c.text));
  if (aggregate.length === 0 || aggregate.length === weights.length) return [];

  return [
    refusal({
      scope: 'page',
      code: 'AMBIGUOUS_UNIT_SEMANTICS',
      page: parsed.page,
      field: 'weight',
      humanMessage:
        `The weight column on page ${parsed.page} does not mean the same thing on ` +
        `every line. Most rows give the weight of a single item, but at least one ` +
        `gives a weight for the whole line. These figures cannot be compared or ` +
        `added up without someone confirming which is which.`,
      evidence: weights.map((c) => ev(parsed.page, c.text)),
    }),
  ];
}

/** Counted nouns that appear in the free text and can disagree between lines. */
const COUNTED = /(\d+)\s+(pallets?|cartons?|packages?|bundles?)\b/gi;

function proseContradictionRefusals(parsed: ParsedPage): Refusal[] {
  const byNoun = new Map<string, { count: number; source: string }[]>();

  for (const cell of parsed.prose) {
    for (const match of cell.text.matchAll(COUNTED)) {
      const noun = match[2].toLowerCase().replace(/s$/, '');
      const list = byNoun.get(noun) ?? [];
      list.push({ count: Number(match[1]), source: cell.text });
      byNoun.set(noun, list);
    }
  }

  const out: Refusal[] = [];
  for (const [noun, sightings] of byNoun) {
    const distinct = new Set(sightings.map((s) => s.count));
    if (distinct.size < 2) continue;

    const counts = [...distinct].sort((a, b) => a - b);
    out.push(
      refusal({
        scope: 'page',
        code: 'CONTRADICTORY_STATEMENT',
        page: parsed.page,
        field: noun,
        humanMessage:
          `Page ${parsed.page} gives two different counts for ${noun}s: ` +
          `${counts.join(' and ')}. The document does not say which is right, and ` +
          `we have not picked one. Both statements are quoted below.`,
        evidence: sightings.map((s) => ev(parsed.page, s.source)),
      }),
    );
  }
  return out;
}

/* ---------------------------------------------------------------- line rules */

/** Flags lines where the printed total does not match the printed qty x price. */
export function lineArithmeticRefusals(items: LineItem[]): Refusal[] {
  const out: Refusal[] = [];

  for (const item of items) {
    if (!item.quantity || !item.unitPrice || !item.lineTotal) continue;

    // Multiply before converting to cents. Rounding the unit price first would
    // turn a sub-cent price like $0.335 into a discrepancy the size of the
    // quantity, and report a mismatch that is ours rather than the document's.
    const expected = Math.round(item.quantity.value * item.unitPrice.value * 100);
    const printed = toCents(item.lineTotal.value);
    if (Math.abs(expected - printed) <= 1) continue;

    out.push(
      refusal({
        scope: 'line',
        code: 'LINE_ARITHMETIC_MISMATCH',
        page: item.page,
        lineNumber: item.lineNumber,
        humanMessage:
          `Line ${item.lineNumber} on page ${item.page} does not add up. ` +
          `${item.quantity.value} x ${formatMoney(item.unitPrice.value)} comes to ` +
          `${formatMoney(expected / 100)}, but the line total printed is ` +
          `${formatMoney(item.lineTotal.value)}. Both figures are shown as printed; ` +
          `neither has been corrected.`,
        evidence: [
          item.quantity.evidence,
          item.unitPrice.evidence,
          item.lineTotal.evidence,
        ],
      }),
    );
  }

  return out;
}
