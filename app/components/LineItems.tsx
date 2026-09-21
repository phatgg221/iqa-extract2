'use client';

import { useState } from 'react';
import type { LineItem, PageResult, Traced } from '@/lib/extract/types';
import { money } from '@/lib/labels';
import { EvidenceQuote } from './Evidence';

/** A figure that was not printed. Never a zero, never a blank that looks like one. */
function NotPrinted() {
  return (
    <span className="text-xs italic text-slate-400" title="Not printed on the document">
      not printed
    </span>
  );
}

function SourceRow({ label, traced }: { label: string; traced: Traced<string | number> | null }) {
  if (!traced) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="w-20 shrink-0 text-xs font-medium text-slate-500">{label}</span>
      <EvidenceQuote evidence={traced.evidence} />
    </div>
  );
}

function Row({ item }: { item: LineItem }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr className="border-t border-slate-200">
        <td className="py-2 pr-3 align-top text-sm tabular-nums text-slate-500">
          {item.lineNumber}
        </td>
        <td className="py-2 pr-3 align-top text-sm text-slate-900">
          {item.description.value}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-2 cursor-pointer text-xs font-medium text-sky-700 underline underline-offset-2 hover:text-sky-900"
            aria-expanded={open}
          >
            {open ? 'hide source' : 'source'}
          </button>
        </td>
        <td className="py-2 pr-3 text-right align-top text-sm tabular-nums text-slate-900">
          {item.quantity ? item.quantity.value.toLocaleString('en-NZ') : <NotPrinted />}
        </td>
        <td className="py-2 pr-3 align-top text-sm text-slate-600">
          {item.unit?.value ?? <NotPrinted />}
        </td>
        <td className="py-2 pr-3 text-right align-top text-sm tabular-nums text-slate-900">
          {item.unitPrice ? money(item.unitPrice.value) : <NotPrinted />}
        </td>
        <td className="py-2 text-right align-top text-sm font-medium tabular-nums text-slate-900">
          {item.lineTotal ? money(item.lineTotal.value) : <NotPrinted />}
        </td>
      </tr>

      {open && (
        <tr className="bg-slate-50">
          <td />
          <td colSpan={5} className="px-0 py-2 pr-3">
            <div className="space-y-1">
              <SourceRow label="Description" traced={item.description} />
              <SourceRow label="Quantity" traced={item.quantity} />
              <SourceRow label="Unit" traced={item.unit} />
              <SourceRow label="Unit price" traced={item.unitPrice} />
              <SourceRow label="Line total" traced={item.lineTotal} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function PageItems({ page }: { page: PageResult }) {
  return (
    <section className="rounded-lg border border-slate-200">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-slate-900">Page {page.page}</h3>
        {page.title && (
          <span className="text-xs text-slate-600">{page.title.value}</span>
        )}
      </header>

      {page.lineItems.length === 0 ? (
        <p className="px-4 py-3 text-sm text-slate-500">
          No line items were taken from this page. See the list of things not
          extracted for the reason.
        </p>
      ) : (
        <div className="overflow-x-auto px-4 pb-3">
          <table className="w-full min-w-[40rem]">
            <thead>
              <tr className="text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3 font-medium">#</th>
                <th className="py-2 pr-3 font-medium">Description</th>
                <th className="py-2 pr-3 text-right font-medium">Qty</th>
                <th className="py-2 pr-3 font-medium">Unit</th>
                <th className="py-2 pr-3 text-right font-medium">Unit price</th>
                <th className="py-2 text-right font-medium">Line total</th>
              </tr>
            </thead>
            <tbody>
              {page.lineItems.map((item) => (
                <Row key={`${item.page}-${item.lineNumber}`} item={item} />
              ))}
            </tbody>
          </table>

          {page.statedTotal && (
            <div className="mt-2 flex flex-wrap items-baseline justify-end gap-x-3 border-t border-slate-200 pt-2">
              <span className="text-xs text-slate-500">Total printed on this page</span>
              <span className="text-sm font-semibold tabular-nums text-slate-900">
                {money(page.statedTotal.value)}
              </span>
              <EvidenceQuote evidence={page.statedTotal.evidence} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
