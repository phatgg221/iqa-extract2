/**
 * The extraction worker.
 *
 * Claims one job at a time with `for update skip locked`, downloads the PDF
 * from the bucket, and runs the same `extract()` the synchronous route used
 * to call. Nothing in `lib/extract` changed to make this work — it is plain
 * TypeScript whose only dependency is pdfjs, so the tested behaviour carries
 * over exactly.
 *
 * Run it with `npm run worker`.
 *
 * The distinction this file exists to preserve:
 *
 *   succeeded = we read the document. Its result may be nothing but refusals.
 *   failed    = we never got to look at the document at all.
 *
 * Collapsing those two is how "page 4 is a scan we cannot read" becomes
 * "job failed", which is the exact failure the whole project is about.
 */

import { admin, BUCKET } from '@/lib/supabase/admin';
import { extract, UnreadablePdfError } from '@/lib/extract/extract';
import type { JobRow } from '@/lib/jobs/types';

const IDLE_POLL_MS = 2000;
const STALL_TIMEOUT = '10 minutes';

/** Progress is only written when the number changes, to avoid a write per page. */
function throttleProgress(jobId: string) {
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

async function claim(): Promise<JobRow | null> {
  const { data, error } = await admin().rpc('claim_extraction_job');
  if (error) throw new Error(`could not claim a job: ${error.message}`);
  // The function returns a composite row, or nothing when the queue is empty.
  return (data as JobRow | null) ?? null;
}

async function markFailed(job: JobRow, code: string, humanMessage: string) {
  await admin()
    .from('extraction_jobs')
    .update({
      status: 'failed',
      failure_code: code,
      failure_message: humanMessage,
      finished_at: new Date().toISOString(),
    })
    .eq('id', job.id);

  console.error(`[${job.id}] failed (${code}): ${humanMessage}`);
}

async function runJob(job: JobRow) {
  console.log(`[${job.id}] claimed ${job.file_name} (${job.byte_size} bytes)`);

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
    result = await extract(bytes, job.file_name, { onPage: throttleProgress(job.id) });
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

  // Reached here means we read the document. Refusals inside it are the
  // result, not a failure, so the job succeeds either way.
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

async function reapStalled() {
  const { data, error } = await admin().rpc('reap_stalled_extraction_jobs', {
    stall_timeout: STALL_TIMEOUT,
  });
  if (error) {
    console.warn(`stalled-job sweep failed: ${error.message}`);
    return;
  }
  const reaped = (data as JobRow[] | null) ?? [];
  for (const job of reaped) console.warn(`[${job.id}] reaped as stalled`);
}

async function main() {
  console.log(`worker started — polling for jobs every ${IDLE_POLL_MS}ms`);

  let running = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n${signal} received — finishing the current job then stopping`);
      running = false;
    });
  }

  while (running) {
    try {
      const job = await claim();

      if (!job) {
        await reapStalled();
        await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
        continue;
      }

      await runJob(job);
    } catch (err) {
      // The loop itself must survive anything, or one bad job stops the queue.
      console.error(
        `worker loop error: ${err instanceof Error ? err.message : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
    }
  }

  console.log('worker stopped');
}

void main();
