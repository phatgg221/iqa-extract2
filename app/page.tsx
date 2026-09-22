'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtractionResult } from '@/lib/extract/types';
import { JobError, fetchHistory, loadJob, submitDocument } from '@/lib/jobs/client';
import type { JobHistoryPage, JobSummary } from '@/lib/jobs/types';
import { JobHistory } from './components/JobHistory';
import { ResultView } from './components/ResultView';

/**
 * The upload no longer goes through our API — the browser PUTs the file
 * straight into storage and a consumer reads it — so the page tracks a job
 * rather than a request. `stage` is what the user is told is happening; it
 * exists because a long wait with no explanation is its own kind of generic
 * error.
 */
type State =
  | { status: 'idle' }
  | {
      status: 'working';
      fileName: string;
      stage: string;
      pagesDone: number;
      pageCount: number | null;
    }
  | { status: 'done'; result: ExtractionResult }
  | { status: 'failed'; fileName: string; reason: string };

/**
 * A history that is quietly empty looks exactly like one that failed to load,
 * so the reason is shown rather than swallowed.
 */
function historyErrorMessage(err: unknown): string {
  return err instanceof JobError
    ? err.humanMessage
    : `The list of previous uploads could not be loaded. ` +
        `${err instanceof Error ? err.message : String(err)}`;
}

/** Rows per page of history. */
const PAGE_SIZE = 10;

/** Shipped in `public/samples` so the behaviour can be seen without hunting for files. */
const SAMPLES = [
  { file: 'KBS-10234.pdf', note: 'clean' },
  { file: 'KBS-10241.pdf', note: 'scanned' },
  { file: 'KBS-10255.pdf', note: 'no line totals' },
  { file: 'KBS-10262.pdf', note: 'contradicts itself' },
  { file: 'KBS-10270.pdf', note: 'total mismatch' },
  { file: 'KBS-DR118.pdf', note: '8 pages, one scanned' },
];

export default function Home() {
  const [state, setState] = useState<State>({ status: 'idle' });
  const [history, setHistory] = useState<JobHistoryPage>({
    jobs: [],
    total: 0,
    limit: PAGE_SIZE,
    offset: 0,
  });
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [openingJobId, setOpeningJobId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Called from event handlers, after an upload finishes or on demand. */
  const refreshHistory = useCallback(async (offset = 0) => {
    try {
      const page = await fetchHistory({ limit: PAGE_SIZE, offset });
      setHistory(page);
      setHistoryError(null);
    } catch (err) {
      setHistoryError(historyErrorMessage(err));
    }
  }, []);

  // Written inline rather than calling refreshHistory, so the await is visible
  // to the lint rule that guards against setting state synchronously in an
  // effect. `alive` stops a slow response updating a page that has gone.
  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const page = await fetchHistory({ limit: PAGE_SIZE, offset: 0 });
        if (alive) {
          setHistory(page);
          setHistoryError(null);
        }
      } catch (err) {
        if (alive) setHistoryError(historyErrorMessage(err));
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  async function upload(file: File) {
    const working = (stage: string, pagesDone = 0, pageCount: number | null = null) =>
      setState({ status: 'working', fileName: file.name, stage, pagesDone, pageCount });

    working(`Uploading ${(file.size / 1024 / 1024).toFixed(1)} MB to storage`);

    try {
      const final = await submitDocument(file, {
        onJobCreated: (jobId) => setActiveJobId(jobId),
        onUploaded: () => {
          working('Uploaded — waiting to be read');
          // The new job is the newest row, so show the page it is actually on.
          void refreshHistory(0);
        },
        onProgress: (status) => {
          if (status.status === 'queued') {
            working('Queued — waiting to be read');
          } else if (status.status === 'processing') {
            working(
              status.pageCount
                ? `Reading page ${status.pagesDone} of ${status.pageCount}`
                : 'Reading the document',
              status.pagesDone,
              status.pageCount,
            );
          }
        },
      });

      void refreshHistory(0);

      // A job that failed still carries a real reason, written by the consumer
      // and passed through untouched. A job that succeeded may be nothing but
      // refusals, and that is a result, not a failure.
      if (final.status === 'failed') {
        setState({
          status: 'failed',
          fileName: file.name,
          reason:
            final.failure?.humanMessage ??
            'The document failed to process and no reason was recorded, which is ' +
              'itself a bug. Please report it.',
        });
        return;
      }

      if (!final.result) {
        setState({
          status: 'failed',
          fileName: file.name,
          reason:
            'The job finished successfully but came back without a result, which ' +
            'should not be possible. Please report it.',
        });
        return;
      }

      setState({ status: 'done', result: final.result });
    } catch (err) {
      void refreshHistory(0);
      setState({
        status: 'failed',
        fileName: file.name,
        reason:
          err instanceof JobError
            ? err.humanMessage
            : `The upload did not complete. ` +
              `${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function uploadSample(name: string) {
    setState({
      status: 'working',
      fileName: name,
      stage: 'Fetching the sample document',
      pagesDone: 0,
      pageCount: null,
    });
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

  /** Re-opens a finished job from the history without reading the document again. */
  async function openJob(job: JobSummary) {
    setOpeningJobId(job.jobId);
    try {
      const status = await loadJob(job.jobId);
      setActiveJobId(job.jobId);

      if (status.result) {
        setState({ status: 'done', result: status.result });
      } else {
        setState({
          status: 'failed',
          fileName: job.fileName,
          reason:
            status.failure?.humanMessage ??
            'This job has no stored result, which should not be possible for one ' +
              'that finished. Please upload the document again.',
        });
      }
    } catch (err) {
      setState({
        status: 'failed',
        fileName: job.fileName,
        reason:
          err instanceof JobError
            ? err.humanMessage
            : `That result could not be reopened. ` +
              `${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setOpeningJobId(null);
    }
  }

  const busy = state.status === 'working';

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
              setActiveJobId(null);
              if (inputRef.current) inputRef.current.value = '';
            }}
            className="cursor-pointer rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Clear
          </button>
        )}
      </div>

      <section className="mb-8">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Previous uploads
          </h2>
          <button
            type="button"
            onClick={() => void refreshHistory(history.offset)}
            className="cursor-pointer text-xs font-medium text-sky-700 underline underline-offset-2 hover:text-sky-900"
          >
            Refresh
          </button>
        </div>

        <JobHistory
          page={history}
          activeJobId={activeJobId}
          loadingJobId={openingJobId}
          error={historyError}
          onOpen={(job) => void openJob(job)}
          onPage={(offset) => void refreshHistory(offset)}
        />

        {/*
          Kept alongside the history rather than replaced by it: on a fresh
          database there is nothing to list, and the samples are the quickest
          way to see what the service does with an awkward document.
        */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">Or try a sample:</span>
          {SAMPLES.map((sample) => (
            <button
              key={sample.file}
              type="button"
              disabled={busy}
              onClick={() => void uploadSample(sample.file)}
              className="cursor-pointer rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <span className="font-medium">{sample.file.replace('.pdf', '')}</span>
              <span className="ml-1.5 text-slate-500">{sample.note}</span>
            </button>
          ))}
        </div>
      </section>

      {busy && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3"
        >
          <span className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
          <div className="min-w-0">
            <p className="text-sm text-slate-700">
              {state.fileName} — {state.stage}.
            </p>
            {state.pageCount !== null && state.pageCount > 0 && (
              <div
                className="mt-2 h-1.5 w-56 overflow-hidden rounded-full bg-slate-200"
                role="progressbar"
                aria-valuenow={state.pagesDone}
                aria-valuemin={0}
                aria-valuemax={state.pageCount}
              >
                <div
                  className="h-full rounded-full bg-slate-700 transition-[width] duration-300"
                  style={{ width: `${(state.pagesDone / state.pageCount) * 100}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/*
        The failure path shows the reason the server actually gave. Replacing
        this with a generic message is the specific bug this page exists to
        avoid: a refusal that never reaches the person reading the screen.
      */}
      {state.status === 'failed' && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3">
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
