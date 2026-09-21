import type { ExtractionResult } from '@/lib/extract/types';
import { money } from '@/lib/labels';
import { EvidenceQuote } from './Evidence';
import { PageItems } from './LineItems';
import { RefusalList } from './RefusalList';

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-900">{value}</dd>
    </div>
  );
}

/**
 * The document total is the figure a person will act on, so it gets the only
 * large number on the page - and when it is withheld, the space it would have
 * occupied says so plainly instead of being left empty or showing a zero.
 */
function DocumentTotal({ result }: { result: ExtractionResult }) {
  if (result.documentTotal) {
    return (
      <div className="rounded-lg border border-slate-300 bg-white px-4 py-3">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Document total
        </p>
        <p className="mt-0.5 text-2xl font-semibold tabular-nums text-slate-900">
          {money(result.documentTotal.value)}
        </p>
        <div className="mt-1.5">
          <EvidenceQuote evidence={result.documentTotal.evidence} />
        </div>
      </div>
    );
  }

  // Several refusals can bear on the total; the one that explains its absence
  // directly is the one to lead with, not whichever happened to be raised first.
  const reason =
    result.refusals.find((r) => r.code === 'DOCUMENT_TOTAL_MISMATCH') ??
    result.refusals.find((r) => r.code === 'DOCUMENT_TOTAL_ABSENT') ??
    result.refusals.find((r) => r.field === 'documentTotal');

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-amber-800">
        Document total
      </p>
      <p className="mt-0.5 text-lg font-semibold text-amber-900">Not reported</p>
      {reason && (
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-800">
          {reason.humanMessage}
        </p>
      )}
    </div>
  );
}

export function ResultView({ result }: { result: ExtractionResult }) {
  const readablePages = result.pages.filter((p) => p.extracted).length;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <dl className="flex flex-wrap gap-x-10 gap-y-3">
          <Meta label="File" value={result.fileName} />
          <Meta label="Document no." value={result.documentNumber?.value ?? 'not printed'} />
          <Meta label="Date" value={result.documentDate?.value ?? 'not printed'} />
          <Meta
            label="Pages read"
            value={`${readablePages} of ${result.pageCount}`}
          />
          <Meta label="Line items" value={String(result.lineItems.length)} />
        </dl>
      </section>

      <DocumentTotal result={result} />

      {/*
        Two sections of equal standing. What we could not extract is not an
        appendix to the result; for some documents it is the entire result.
      */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-slate-900">
          Extracted ({result.lineItems.length}{' '}
          {result.lineItems.length === 1 ? 'line item' : 'line items'})
        </h2>
        {result.lineItems.length === 0 ? (
          <p className="rounded-lg border border-slate-200 px-4 py-3 text-sm text-slate-600">
            Nothing could be extracted from this document. The reasons are listed
            below - this is a result, not a failure to try.
          </p>
        ) : (
          <div className="space-y-4">
            {result.pages.map((page) => (
              <PageItems key={page.page} page={page} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold text-slate-900">
          Not extracted ({result.refusals.length}{' '}
          {result.refusals.length === 1 ? 'item' : 'items'} we could not confirm)
        </h2>
        <RefusalList refusals={result.refusals} />
      </section>
    </div>
  );
}
