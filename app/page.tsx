'use client';

import { useRef, useState } from 'react';
import type { ExtractionResult } from '@/lib/extract/types';
import { ResultView } from './components/ResultView';

type State =
  | { status: 'idle' }
  | { status: 'reading'; fileName: string }
  | { status: 'done'; result: ExtractionResult }
  | { status: 'failed'; fileName: string; reason: string };

/**
 * Turns a failed response into the real reason it failed.
 *
 * Everything here works to keep a specific explanation on screen. The API
 * sends a `humanMessage` for every error it knows about; when something
 * unforeseen happens we still report the status and the actual exception
 * rather than falling back to "something went wrong", because the whole
 * point of this page is that the true reason survives the trip.
 */
async function reasonFor(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (typeof body?.error?.humanMessage === 'string') return body.error.humanMessage;
    return (
      `The server responded with ${response.status} ${response.statusText} but did ` +
      `not explain why. The raw response was: ${JSON.stringify(body).slice(0, 300)}`
    );
  } catch {
    return (
      `The server responded with ${response.status} ${response.statusText} and the ` +
      `response body could not be read as JSON.`
    );
  }
}

/** Shipped in `public/samples` so the behaviour can be seen without hunting for files. */
const SAMPLES = [
  { file: 'KBS-10234.pdf', note: 'clean' },
  { file: 'KBS-10241.pdf', note: 'scanned' },
  { file: 'KBS-10255.pdf', note: 'no line totals' },
  { file: 'KBS-10262.pdf', note: 'contradicts itself' },
  { file: 'KBS-10270.pdf', note: 'total mismatch' },
  { file: 'KBS-DR118.pdf', note: '8 pages, one unreadable' },
];

export default function Home() {
  const [state, setState] = useState<State>({ status: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setState({ status: 'reading', fileName: file.name });

    const body = new FormData();
    body.append('file', file);

    try {
      const response = await fetch('/api/extract', { method: 'POST', body });

      if (!response.ok) {
        setState({
          status: 'failed',
          fileName: file.name,
          reason: await reasonFor(response),
        });
        return;
      }

      setState({ status: 'done', result: (await response.json()) as ExtractionResult });
    } catch (err) {
      setState({
        status: 'failed',
        fileName: file.name,
        reason:
          `The upload never reached the extraction service. ` +
          `${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function uploadSample(name: string) {
    setState({ status: 'reading', fileName: name });
    try {
      const response = await fetch(`/samples/${name}`);
      if (!response.ok) throw new Error(`the sample file returned ${response.status}`);
      await upload(new File([await response.blob()], name, { type: 'application/pdf' }));
    } catch (err) {
      setState({
        status: 'failed',
        fileName: name,
        reason:
          `The bundled sample could not be loaded: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const busy = state.status === 'reading';

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <header className="mb-8">
        <h1 className="text-xl font-semibold text-slate-900">Document extraction</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">
          Upload a delivery docket, packing list or invoice. Every figure below is
          quoted from the page it came from. Anything that could not be read, or that
          the document contradicts itself about, is listed and explained rather than
          guessed at.
        </p>
      </header>

      <div className="mb-8 flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
          className="block w-full max-w-md cursor-pointer rounded-lg border border-slate-300 text-sm text-slate-700 file:mr-4 file:cursor-pointer file:border-0 file:bg-slate-900 file:px-4 file:py-2.5 file:text-sm file:font-medium file:text-white hover:file:bg-slate-700 disabled:opacity-50"
        />
        {state.status !== 'idle' && !busy && (
          <button
            type="button"
            onClick={() => {
              setState({ status: 'idle' });
              if (inputRef.current) inputRef.current.value = '';
            }}
            className="cursor-pointer rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Clear
          </button>
        )}
      </div>

      <div className="mb-8">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
          Or try a sample document
        </p>
        <div className="flex flex-wrap gap-2">
          {SAMPLES.map((sample) => (
            <button
              key={sample.file}
              type="button"
              disabled={busy}
              onClick={() => void uploadSample(sample.file)}
              className="cursor-pointer rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <span className="font-medium">{sample.file.replace('.pdf', '')}</span>
              <span className="ml-1.5 text-slate-500">{sample.note}</span>
            </button>
          ))}
        </div>
      </div>

      {busy && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3"
        >
          <span className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
          <p className="text-sm text-slate-700">
            Reading {state.fileName} — checking each page for a text layer and
            matching every figure to its source.
          </p>
        </div>
      )}

      {/*
        The failure path shows the reason the server actually gave. Replacing
        this with a generic message is the specific bug this page exists to
        avoid: a refusal that never reaches the person reading the screen.
      */}
      {state.status === 'failed' && (
        <div
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-4 py-3"
        >
          <h2 className="text-sm font-semibold text-red-900">
            {state.fileName} could not be read
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-800">{state.reason}</p>
        </div>
      )}

      {state.status === 'done' && <ResultView result={state.result} />}
    </main>
  );
}
