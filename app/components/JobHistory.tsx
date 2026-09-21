'use client';

import type { JobStatus, JobSummary } from '@/lib/jobs/types';

/** Short, unfussy relative time. Exact timestamps are not the point here. */
function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const STATUS_STYLE: Record<JobStatus, string> = {
  awaiting_upload: 'bg-slate-100 text-slate-600',
  queued: 'bg-slate-100 text-slate-600',
  processing: 'bg-sky-100 text-sky-800',
  succeeded: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
};

const STATUS_LABEL: Record<JobStatus, string> = {
  awaiting_upload: 'waiting for file',
  queued: 'queued',
  processing: 'reading',
  succeeded: 'read',
  failed: 'failed',
};

/**
 * What a row says about its outcome.
 *
 * A job with nothing but refusals still succeeded — we read the document, and
 * the refusals are the result. So the count of refusals sits beside the count
 * of line items rather than being styled as an error, and "0 line items" is
 * reported plainly instead of looking like a failure.
 */
function outcome(job: JobSummary): string {
  if (job.status === 'failed') return job.failureMessage ?? 'could not be read';
  if (job.status !== 'succeeded') {
    return job.pageCount ? `page ${job.pageCount ? job.pageCount : '?'}` : 'in progress';
  }

  // Unknown is not zero. If the counts were never recorded, say nothing rather
  // than reporting "0 line items" for a document that has plenty; the status
  // pill already says the document was read.
  if (job.lineItemCount === null) return '';

  const items = job.lineItemCount;
  const refusals = job.refusalCount ?? 0;
  const parts = [`${items} line ${items === 1 ? 'item' : 'items'}`];
  if (refusals > 0) parts.push(`${refusals} not confirmed`);
  return parts.join(' · ');
}

export function JobHistory({
  jobs,
  activeJobId,
  loadingJobId,
  error,
  onOpen,
}: {
  jobs: JobSummary[];
  activeJobId: string | null;
  loadingJobId: string | null;
  /** The real reason the history could not be read, passed through verbatim. */
  error: string | null;
  onOpen: (job: JobSummary) => void;
}) {
  if (error) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50/60 px-4 py-3">
        <h3 className="text-sm font-semibold text-amber-900">
          Previous uploads could not be listed
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-slate-800">{error}</p>
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500">
        Nothing uploaded yet. Anything you read will be listed here.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200">
      {jobs.map((job) => {
        const isActive = job.jobId === activeJobId;
        const isLoading = job.jobId === loadingJobId;
        // Failed jobs open too — the reason is the result, and it deserves
        // the full width of the page rather than a truncated row.
        const openable = job.status === 'succeeded' || job.status === 'failed';

        return (
          <li key={job.jobId}>
            <button
              type="button"
              disabled={!openable || isLoading}
              onClick={() => onOpen(job)}
              aria-current={isActive ? 'true' : undefined}
              className={
                'flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left ' +
                (isActive ? 'bg-slate-100 ' : 'bg-white ') +
                (openable
                  ? 'cursor-pointer hover:bg-slate-50 '
                  : 'cursor-default ')
              }
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
                {job.fileName}
              </span>

              <span
                className={
                  'shrink-0 rounded px-1.5 py-px text-[11px] font-medium ' +
                  STATUS_STYLE[job.status]
                }
              >
                {isLoading ? 'opening…' : STATUS_LABEL[job.status]}
              </span>

              <span className="w-full min-w-0 truncate text-xs text-slate-600 sm:w-auto sm:max-w-sm sm:flex-none">
                {outcome(job)}
              </span>

              <span className="shrink-0 text-xs tabular-nums text-slate-400">
                {ago(job.createdAt)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
