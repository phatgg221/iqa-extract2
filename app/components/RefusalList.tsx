import type { Refusal } from '@/lib/extract/types';
import { REFUSAL_TITLES } from '@/lib/labels';
import { EvidenceList } from './Evidence';

/**
 * Refusals are presented as findings, not as failures. They sit alongside the
 * extracted items with the same visual weight, because "we could not confirm
 * this" is a result the person needs, not an error to be apologised for.
 */
export function RefusalList({
  refusals,
  readByOcr = false,
}: {
  refusals: Refusal[];
  /** True when any figure on the document came from a scan rather than the file. */
  readByOcr?: boolean;
}) {
  if (refusals.length === 0) {
    // "Nothing was refused" means something different on a scan, and saying
    // the figures were "read directly from the page" when they were read off
    // an image would be exactly the kind of quiet overclaim this whole service
    // is built to avoid.
    return readByOcr ? (
      <p className="rounded-lg border border-amber-300 bg-amber-50/60 px-4 py-3 text-sm text-slate-800">
        Nothing was refused, and every line adds up. But this document is a scan:
        the figures were read from the image by OCR, not from the document itself,
        and each one is marked with how certain that reading was. Check them against
        the original before quoting from them.
      </p>
    ) : (
      <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        Nothing was refused. Every figure on this document was read directly from the
        page and its line items agree with the totals printed on it.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {refusals.map((refusal, i) => (
        <li
          key={i}
          className="rounded-lg border border-amber-300 bg-amber-50/60 px-4 py-3"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="text-sm font-semibold text-amber-900">
              {REFUSAL_TITLES[refusal.code]}
            </h3>
            <span className="text-xs text-amber-700">
              {refusal.page !== null ? `Page ${refusal.page}` : 'Whole document'}
              {refusal.lineNumber !== null ? `, line ${refusal.lineNumber}` : ''}
            </span>
          </div>

          {/*
            Rendered verbatim from the engine. Nothing here is rewritten or
            replaced with a generic message on the way to the screen.
          */}
          <p className="mt-1.5 text-sm leading-relaxed text-slate-800">
            {refusal.humanMessage}
          </p>

          <EvidenceList evidence={refusal.evidence} />
        </li>
      ))}
    </ul>
  );
}
