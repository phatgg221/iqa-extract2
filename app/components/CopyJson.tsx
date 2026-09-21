'use client';

import { useState } from 'react';
import type { ExtractionResult } from '@/lib/extract/types';

type State =
  | { status: 'idle' }
  | { status: 'copied' }
  | { status: 'failed'; reason: string };

/**
 * Puts the raw API response on the clipboard.
 *
 * This is the Part A payload exactly as the service returned it, refusals and
 * all, so what is on screen can be checked against what was actually sent.
 *
 * The clipboard can legitimately refuse - it needs a secure context and the
 * page may be embedded somewhere that blocks it - so a failure here says what
 * went wrong and offers the file instead, rather than leaving a button that
 * silently does nothing.
 */
export function CopyJson({ result }: { result: ExtractionResult }) {
  const [state, setState] = useState<State>({ status: 'idle' });

  const json = JSON.stringify(result, null, 2);

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error(
          'this browser did not make a clipboard available to the page, which ' +
            'usually means the page is not being served over https or localhost',
        );
      }
      await navigator.clipboard.writeText(json);
      setState({ status: 'copied' });
      window.setTimeout(() => setState({ status: 'idle' }), 2000);
    } catch (err) {
      setState({
        status: 'failed',
        reason: (err instanceof Error ? err.message : String(err)).replace(/\.$/, ''),
      });
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${result.fileName.replace(/\.pdf$/i, '')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void copy()}
          className="cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          {state.status === 'copied' ? 'Copied' : 'Copy JSON'}
        </button>
        <button
          type="button"
          onClick={download}
          className="cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Download
        </button>
      </div>

      {state.status === 'copied' && (
        <p className="text-xs text-slate-500">
          {result.lineItems.length} line{' '}
          {result.lineItems.length === 1 ? 'item' : 'items'} and{' '}
          {result.refusals.length}{' '}
          {result.refusals.length === 1 ? 'refusal' : 'refusals'}, as returned by
          the API.
        </p>
      )}

      {state.status === 'failed' && (
        <p className="max-w-sm text-right text-xs text-red-700">
          The JSON could not be copied: {state.reason}. Use Download instead.
        </p>
      )}
    </div>
  );
}
