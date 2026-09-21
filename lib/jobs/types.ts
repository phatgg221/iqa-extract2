/**
 * The job contract, shared by the API routes, the worker and the browser.
 *
 * The rule the synchronous version established carries over unchanged: a
 * document we read and then refused in full is a **succeeded** job whose
 * result is full of refusals. `failed` means we never got to look at the
 * document at all. Collapsing the two would turn every refusal into
 * "job failed", which is the failure this project exists to avoid.
 */

import type { ExtractionResult } from '@/lib/extract/types';

export type JobStatus =
  | 'awaiting_upload'
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'failed';

export const TERMINAL: JobStatus[] = ['succeeded', 'failed'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

/** A job row as the database stores it. */
export interface JobRow {
  id: string;
  folder_name: string;
  object_key: string;
  file_name: string;
  byte_size: number;
  content_type: string | null;
  status: JobStatus;
  page_count: number | null;
  pages_done: number;
  result: ExtractionResult | null;
  failure_code: string | null;
  failure_message: string | null;
  attempts: number;
  /** Written alongside the result, so the history list need not load it. */
  line_item_count: number | null;
  refusal_count: number | null;
  created_at: string;
  uploaded_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/** One row in the upload history. Deliberately without the result blob. */
export interface JobSummary {
  jobId: string;
  fileName: string;
  status: JobStatus;
  pageCount: number | null;
  lineItemCount: number | null;
  refusalCount: number | null;
  /** Present only for a failed job, and always a real explanation. */
  failureMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export function toSummary(row: JobRow): JobSummary {
  return {
    jobId: row.id,
    fileName: row.file_name,
    status: row.status,
    pageCount: row.page_count,
    // Coerced because these columns may not exist yet (migration 0004), in
    // which case PostgREST simply omits them and they arrive undefined.
    lineItemCount: row.line_item_count ?? null,
    refusalCount: row.refusal_count ?? null,
    failureMessage: row.status === 'failed' ? row.failure_message : null,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/** What `POST /api/jobs` returns: everything the browser needs to upload. */
export interface CreatedJob {
  jobId: string;
  objectKey: string;
  /** Supabase signed upload token, passed to `uploadToSignedUrl`. */
  uploadToken: string;
  bucket: string;
}

/**
 * The small message broadcast over Realtime as a job moves.
 *
 * Deliberately just the state, never the result: a 400-page document's
 * `ExtractionResult` is megabytes and would blow the broadcast payload limit.
 * The signal says "something changed"; the browser fetches the authoritative
 * answer once the job is terminal.
 */
export interface JobSignal {
  status: JobStatus;
  pagesDone: number;
  pageCount: number | null;
}

/** What `GET /api/jobs/{id}` returns. A superset of `JobSignal`. */
export interface JobStatusResponse {
  jobId: string;
  fileName: string;
  status: JobStatus;
  pagesDone: number;
  pageCount: number | null;
  /** Present only once the job has succeeded. */
  result: ExtractionResult | null;
  /** Present only once the job has failed, and always a real explanation. */
  failure: { code: string; humanMessage: string } | null;
}

export function toStatusResponse(row: JobRow): JobStatusResponse {
  return {
    jobId: row.id,
    fileName: row.file_name,
    status: row.status,
    pagesDone: row.pages_done,
    pageCount: row.page_count,
    result: row.status === 'succeeded' ? row.result : null,
    failure:
      row.status === 'failed'
        ? {
            code: row.failure_code ?? 'UNKNOWN',
            humanMessage:
              row.failure_message ??
              'This document failed to process and no reason was recorded, ' +
                'which is itself a bug. Please report it.',
          }
        : null,
  };
}
