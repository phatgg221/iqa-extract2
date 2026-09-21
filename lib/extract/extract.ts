/**
 * Orchestrator: bytes in, `ExtractionResult` out.
 *
 * Two shapes matter here.
 *
 * 1. Containment. Each page is parsed inside its own try/catch, so a page we
 *    cannot read becomes one refusal and the remaining pages still return
 *    their line items. One bad page never costs you the document.
 *
 * 2. Withholding. A document total is published only when the document prints
 *    one and nothing contradicts it. Otherwise it is null and the refusals say
 *    why. Summing the pages ourselves would be inventing the number the user
 *    most wants, which is exactly the thing not to do.
 */

import { readPages, UnreadablePdfError, type RawPage } from './pdf';
import { parsePage, readRow, type ParsedPage } from './table';
import {
  classifyPage,
  ev,
  lineArithmeticRefusals,
  pageLevelRefusals,
} from './rules';
import { formatMoney, fromCents, toCents } from './money';
import type { ExtractionResult, LineItem, PageResult, Refusal } from './types';

export { UnreadablePdfError };

export async function extract(
  bytes: Uint8Array,
  fileName: string,
): Promise<ExtractionResult> {
  const rawPages = await readPages(bytes);

  const parsedPages: ParsedPage[] = [];
  const refusals: Refusal[] = [];

  for (const raw of rawPages) {
    parsedPages.push(parseOnePage(raw, refusals));
  }

  const pages: PageResult[] = [];
  const lineItems: LineItem[] = [];

  for (const parsed of parsedPages) {
    refusals.push(...pageLevelRefusals(parsed));

    const items = buildLineItems(parsed, refusals);
    lineItems.push(...items);

    pages.push({
      page: parsed.page,
      title: parsed.title
        ? { value: parsed.title.text, evidence: ev(parsed.page, parsed.title.text) }
        : null,
      lineItems: items,
      statedTotal: parsed.statedTotal
        ? {
            value: parsed.statedTotal.value,
            evidence: ev(parsed.page, parsed.statedTotal.cell.text),
          }
        : null,
      extracted: parsed.hasText && parsed.hasTable,
    });
  }

  refusals.push(...lineArithmeticRefusals(lineItems));
  refusals.push(...siteContradictionRefusals(parsedPages));
  refusals.push(...duplicatePageRefusals(pages));

  const { documentTotal, refusals: totalRefusals } = decideDocumentTotal(
    parsedPages,
    lineItems,
  );
  refusals.push(...totalRefusals);

  const meta = parsedPages.find((p) => p.documentNumber);
  const dateMeta = parsedPages.find((p) => p.documentDate);

  return {
    fileName,
    pageCount: rawPages.length,
    documentNumber: meta?.documentNumber
      ? {
          value: meta.documentNumber.value,
          evidence: ev(meta.page, meta.documentNumber.cell.text),
        }
      : null,
    documentDate: dateMeta?.documentDate
      ? {
          value: dateMeta.documentDate.value,
          evidence: ev(dateMeta.page, dateMeta.documentDate.cell.text),
        }
      : null,
    pages,
    lineItems,
    documentTotal,
    refusals,
  };
}

/** Parsing one page must never be able to end the run. */
function parseOnePage(raw: RawPage, refusals: Refusal[]): ParsedPage {
  try {
    return parsePage(raw);
  } catch (err) {
    refusals.push({
      scope: 'page',
      code: 'PAGE_PARSE_FAILED',
      page: raw.page,
      lineNumber: null,
      field: null,
      humanMessage:
        `Page ${raw.page} could not be read because of an unexpected problem ` +
        `while parsing it (${err instanceof Error ? err.message : 'unknown error'}). ` +
        `The other pages in this document were unaffected.`,
      evidence: [],
    });
    return {
      page: raw.page,
      hasText: raw.cells.length > 0,
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
  }
}

function buildLineItems(parsed: ParsedPage, refusals: Refusal[]): LineItem[] {
  const items: LineItem[] = [];
  const page = parsed.page;

  for (const row of parsed.rows) {
    const { cells } = row;
    const description = cells.description;
    if (!description) continue;

    const { quantity, unitPrice, unitFromPrice, lineTotal } = readRow(row);

    // A cell that is present but unreadable is worth saying out loud; it is
    // not the same as a column the document never prints.
    if (cells.qty && quantity === null) {
      refusals.push({
        scope: 'field',
        code: 'UNPARSEABLE_VALUE',
        page,
        lineNumber: row.lineNumber,
        field: 'quantity',
        humanMessage:
          `The quantity on line ${row.lineNumber} of page ${page} reads ` +
          `"${cells.qty.text}", which is not a plain number, so it has been left out ` +
          `rather than interpreted.`,
        evidence: [ev(page, cells.qty.text)],
      });
    }

    const unitCell = cells.unit;

    items.push({
      page,
      lineNumber: row.lineNumber,
      description: { value: description.text, evidence: ev(page, description.text) },
      quantity:
        cells.qty && quantity !== null
          ? { value: quantity, evidence: ev(page, cells.qty.text) }
          : null,
      unit: unitCell
        ? { value: unitCell.text, evidence: ev(page, unitCell.text) }
        : unitFromPrice && cells.unitPrice
          ? { value: unitFromPrice, evidence: ev(page, cells.unitPrice.text) }
          : null,
      unitPrice:
        cells.unitPrice && unitPrice !== null
          ? { value: unitPrice, evidence: ev(page, cells.unitPrice.text) }
          : null,
      lineTotal:
        cells.lineTotal && lineTotal !== null
          ? { value: lineTotal, evidence: ev(page, cells.lineTotal.text) }
          : null,
    });
  }

  return items;
}

/**
 * The multi-site run labels four sites but gives two of them the same street.
 * Either a site is mislabelled or a delivery is recorded twice; we cannot tell
 * which, so we say so.
 */
function siteContradictionRefusals(pages: ParsedPage[]): Refusal[] {
  const SITE = /\bSite\s+(\d+)\s+of\s+(\d+)\s*[-–]\s*(.+)$/i;
  const byAddress = new Map<string, { site: number; page: number; source: string }[]>();

  for (const page of pages) {
    if (!page.title) continue;
    const m = SITE.exec(page.title.text);
    if (!m) continue;
    const address = m[3].trim().toLowerCase();
    const list = byAddress.get(address) ?? [];
    list.push({ site: Number(m[1]), page: page.page, source: page.title.text });
    byAddress.set(address, list);
  }

  const out: Refusal[] = [];
  for (const [, sightings] of byAddress) {
    const sites = new Set(sightings.map((s) => s.site));
    if (sites.size < 2) continue;

    out.push({
      scope: 'document',
      code: 'CONTRADICTORY_STATEMENT',
      page: null,
      lineNumber: null,
      field: 'site',
      humanMessage:
        `Sites ${[...sites].sort((a, b) => a - b).join(' and ')} are listed as ` +
        `separate drops but give the same delivery address. Either one is ` +
        `mislabelled or the same delivery appears twice, and the document does ` +
        `not say which. Their line items are listed separately below and have ` +
        `not been merged or de-duplicated.`,
      evidence: sightings.map((s) => ev(s.page, s.source)),
    });
  }
  return out;
}

/**
 * Pages whose amounts are identical down to the cent are very likely the same
 * figures written out more than once - a summary, a site copy, a signed
 * acceptance - rather than separate deliveries to be added together. We cannot
 * prove that from the page, so we report it instead of de-duplicating.
 */
function duplicatePageRefusals(pages: PageResult[]): Refusal[] {
  const withItems = pages.filter((p) => p.lineItems.length > 0);
  if (withItems.length < 2) return [];

  const fingerprint = (p: PageResult) =>
    p.lineItems
      .map((i) => `${i.quantity?.value ?? '?'}|${i.unitPrice?.value ?? '?'}|${i.lineTotal?.value ?? '?'}`)
      .sort()
      .join(' ; ');

  const groups = new Map<string, PageResult[]>();
  for (const page of withItems) {
    const key = fingerprint(page);
    groups.set(key, [...(groups.get(key) ?? []), page]);
  }

  const out: Refusal[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const numbers = group.map((p) => p.page);
    out.push({
      scope: 'document',
      code: 'POSSIBLE_DUPLICATE_PAGE',
      page: null,
      lineNumber: null,
      field: 'documentTotal',
      humanMessage:
        `Pages ${numbers.join(', ')} carry exactly the same quantities and prices as ` +
        `each other, with only the item descriptions differing. They may be the same ` +
        `figures restated - a summary or a site copy - rather than ${numbers.length} ` +
        `separate deliveries. Every page is listed below as printed, but they have not ` +
        `been added together, because doing so would multiply the value of this ` +
        `document if they are restatements.`,
      evidence: group.flatMap((p) =>
        p.title ? [p.title.evidence] : [p.lineItems[0].description.evidence],
      ),
    });
  }
  return out;
}

function decideDocumentTotal(
  pages: ParsedPage[],
  lineItems: LineItem[],
): { documentTotal: ExtractionResult['documentTotal']; refusals: Refusal[] } {
  const refusals: Refusal[] = [];
  const withTotal = pages.filter((p) => p.statedTotal);

  // Single-page document that prints its own total: the usual case.
  if (pages.length === 1 && withTotal.length === 1) {
    const page = withTotal[0];
    const stated = page.statedTotal!;
    const evidence = ev(page.page, stated.cell.text);

    const totals = lineItems.map((i) => i.lineTotal);
    const allPriced = totals.length > 0 && totals.every((t) => t !== null);

    if (allPriced) {
      const sum = totals.reduce((acc, t) => acc + toCents(t!.value), 0);
      const printed = toCents(stated.value);

      if (Math.abs(sum - printed) > 1) {
        refusals.push({
          scope: 'document',
          code: 'DOCUMENT_TOTAL_MISMATCH',
          page: page.page,
          lineNumber: null,
          field: 'documentTotal',
          humanMessage:
            `The total printed on this document is ${formatMoney(stated.value)}, but ` +
            `its line items add up to ${formatMoney(fromCents(sum))} - a difference of ` +
            `${formatMoney(Math.abs(fromCents(printed - sum)))}. Nothing on the document ` +
            `accounts for the gap. No total is being reported, because we cannot tell ` +
            `whether a line is missing or the printed total is wrong. Both figures are ` +
            `shown so you can check against the original.`,
          evidence: [
            evidence,
            ...lineItems
              .filter((i) => i.lineTotal)
              .map((i) => i.lineTotal!.evidence),
          ],
        });
        return { documentTotal: null, refusals };
      }
    }

    return { documentTotal: { value: stated.value, evidence }, refusals };
  }

  // Anything else: no single printed figure covers the whole document.
  const reasons: string[] = [];
  const evidence = [];

  for (const page of pages) {
    if (!page.hasText) {
      reasons.push(`page ${page.page} is a scan and could not be read`);
      continue;
    }
    const kind = classifyPage(page.title?.text ?? null);
    if (kind.isSummary) {
      reasons.push(
        `page ${page.page} is headed as a summary and may repeat items already ` +
          `counted on earlier pages`,
      );
      if (page.title) evidence.push(ev(page.page, page.title.text));
    }
    if (kind.isReturn || kind.isCredit) {
      reasons.push(
        `page ${page.page} is a ${kind.isReturn ? 'returns note' : 'credit adjustment'}, ` +
          `and the document never says whether its amounts should be added or subtracted`,
      );
      if (page.title) evidence.push(ev(page.page, page.title.text));
    }
  }

  const totalRowNote = pages.find((p) => p.totalRowWithoutAmount);
  if (totalRowNote?.totalRowWithoutAmount) {
    reasons.push(
      `the only total on the document refers you back to the individual lines ` +
        `instead of giving a figure`,
    );
    evidence.push(ev(totalRowNote.page, totalRowNote.totalRowWithoutAmount.text));
  }

  if (withTotal.length === 0 && reasons.length === 0) {
    reasons.push('no total is printed anywhere in the document');
  }

  refusals.push({
    scope: 'document',
    code: 'DOCUMENT_TOTAL_ABSENT',
    page: null,
    lineNumber: null,
    field: 'documentTotal',
    humanMessage:
      `No overall total is being reported for this document. ` +
      `${reasons.length ? `${capitalise(reasons.join('; '))}. ` : ''}` +
      (lineItems.length === 0
        ? `No line items could be read from it either, so there is nothing to add up.`
        : pages.length === 1
          ? `Adding the lines up ourselves would produce a number that does not ` +
            `appear anywhere on the document, so they are listed below as printed ` +
            `for you to total yourself.`
          : `Adding the pages up would produce a number that does not appear ` +
            `anywhere on the document, so the line items are listed per page ` +
            `instead for you to total yourself.`),
    evidence,
  });

  return { documentTotal: null, refusals };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
