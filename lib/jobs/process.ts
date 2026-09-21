/**
 * Doing the work: download, extract, write back.
 *
 * Shared by both consumers, which differ only in how they get hold of a job:
 *
 *   - the Vercel Queues route is handed a job id by a pushed message
 *   - the polling worker claims whatever is next off the table
 *
 * Both funnel into `runClaimedJob`, so there is exactly one implementation of
 * what "process a document" means and one place the succeeded/failed
 * distinction is made.
 */

import { admin, BUCKET } from '@/lib/supabase/admin';
import { extract, UnreadablePdfError } from '@/lib/extract/extract';
import type { JobRow } from './types';

export const EXTRACTION_TOPIC = 'document-extractions';

/** What a delivery did, so the caller can log something true. */
export type ProcessOutcome =
  | { outcome: 'processed'; jobId: string }
  | { outcome: 'skipped'; jobId: string; reason: string };

/** Progress is only written when the number changes, not once per page. */
function progressReporter(jobId: string) {
  let lastWritten = -1;

  return async (pagesDone: number, pageCount: number) => {
    if (pagesDone === lastWritten) return;
    lastWritten = pagesDone;

    const { error } = await admin()
      .from('extraction_jobs')
      .update({ pages_done: pagesDone, page_count: pageCount })
      .eq('id', jobId);

    // A failed progress write must not abort a job that is otherwise fine.
    if (error) console.warn(`[${jobId}] progress update failed: ${error.message}`);
  };
}

/**
 * Records a failure against a job id, whatever state it is in.
 *
 * Exported because the consumer needs it for a case `runClaimedJob` never
 * sees: the job could not even be claimed, and the queue has run out of
 * retries. Without this the row sits untouched and the person watching gets
 * a spinner and then a timeout, while the real reason is sitting in a log.
 */
export async function failJobById(jobId: string, code: string, humanMessage: string) {
  const { error } = await admin()
    .from('extraction_jobs')
    .update({
      status: 'failed',
      failure_code: code,
      failure_message: humanMessage,
      finished_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .neq('status', 'succeeded'); // never overwrite a result we already have

  if (error) console.error(`[${jobId}] could not record failure: ${error.message}`);
  else console.error(`[${jobId}] failed (${code}): ${humanMessage}`);
}

async function markFailed(job: JobRow, code: string, humanMessage: string) {
  await failJobById(job.id, code, humanMessage);
}

/**
 * Runs a job that has already been claimed.
 *
 * The distinction this function exists to hold:
 *
 *   succeeded — we read the document. Its result may be nothing but refusals.
 *   failed    — we never got to look at the document at all.
 *
 * Collapsing those is how "page 4 is a scan we cannot read" becomes
 * "job failed", which is the failure the whole project is about.
 */
export async function runClaimedJob(job: JobRow): Promise<void> {
  console.log(`[${job.id}] processing ${job.file_name} (attempt ${job.attempts})`);

  const { data: blob, error: downloadError } = await admin()
    .storage.from(BUCKET)
    .download(job.object_key);

  if (downloadError || !blob) {
    await markFailed(
      job,
      'DOWNLOAD_FAILED',
      `${job.file_name} could not be fetched from storage, so it was never read. ` +
        `Storage reported: ${downloadError?.message ?? 'no file was returned'}.`,
    );
    return;
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());

  let result;
  try {
    result = await extract(bytes, job.file_name, { onPage: progressReporter(job.id) });
  } catch (err) {
    if (err instanceof UnreadablePdfError) {
      await markFailed(
        job,
        'PDF_UNREADABLE',
        `${job.file_name} could not be opened. The PDF library reported: ` +
          `${err.message.replace(/\.$/, '')}. The file may be encrypted, ` +
          `password-protected or corrupt.`,
      );
      return;
    }
    await markFailed(
      job,
      'UNEXPECTED',
      `Reading ${job.file_name} failed unexpectedly: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const { error: saveError } = await admin()
    .from('extraction_jobs')
    .update({
      status: 'succeeded',
      result,
      page_count: result.pageCount,
      pages_done: result.pageCount,
      finished_at: new Date().toISOString(),
    })
    .eq('id', job.id);

  if (saveError) {
    await markFailed(
      job,
      'RESULT_NOT_SAVED',
      `${job.file_name} was read successfully, but the result could not be stored: ` +
        `${saveError.message}. Please upload it again.`,
    );
    return;
  }

  console.log(
    `[${job.id}] succeeded — ${result.lineItems.length} line items, ` +
      `${result.refusals.length} refusals across ${result.pageCount} pages`,
  );
}

/**
 * Entry point for a pushed message.
 *
 * Delivery is at-least-once, so the first thing to do is try to claim the job.
 * Losing that race is the normal, correct outcome for a duplicate delivery and
 * is not an error — it means someone else already has it, or it is already done.
 */
export async function processJobById(jobId: string): Promise<ProcessOutcome> {
  const { data, error } = await admin().rpc('claim_extraction_job_by_id', {
    job_id: jobId,
  });

  if (error) {
    // Thrown, not swallowed: the queue should redeliver this rather than
    // quietly drop a document because the database blipped.
    throw new Error(`could not claim job ${jobId}: ${error.message}`);
  }

  const job = (data as JobRow | null) ?? null;

  if (!job) {
    return {
      outcome: 'skipped',
      jobId,
      reason: 'already claimed, already finished, or not queued',
    };
  }

  await runClaimedJob(job);
  return { outcome: 'processed', jobId };
}
