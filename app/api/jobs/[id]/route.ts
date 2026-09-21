/**
 * GET /api/jobs/{id} — status, progress, and eventually the result.
 *
 * This endpoint is one of the two new layers a refusal now has to survive, so
 * it does no interpreting: `failure_message` is passed through exactly as the
 * worker wrote it, and a job full of refusals is reported as succeeded,
 * because the refusals are the result.
 */

import { admin, MissingConfigError } from '@/lib/supabase/admin';
import { toStatusResponse, type JobRow } from '@/lib/jobs/types';

export const runtime = 'nodejs';

function fail(status: number, code: string, humanMessage: string) {
  return Response.json({ error: { code, humanMessage } }, { status });
}

/** A job idle longer than this has been abandoned by whatever should have run it. */
const STALL_TIMEOUT_MINUTES = 10;

/**
 * Sweeps stalled jobs when someone polls one that looks abandoned.
 *
 * The sweep also runs in the polling worker, but prod has no worker — there
 * the consumer is a pushed function, so nothing is looping and nothing would
 * ever notice. A job the queue never delivered would sit in `queued` until the
 * browser gave up ten minutes later and said only that it had stopped waiting.
 *
 * Doing it here means the person waiting is the one who triggers it, which is
 * exactly who needs the answer. It only fires for a job that is already past
 * the timeout, so an ordinary poll costs nothing extra.
 */
async function reapIfStale(job: JobRow): Promise<JobRow> {
  if (job.status !== 'queued' && job.status !== 'processing') return job;

  const since = Date.parse(job.started_at ?? job.uploaded_at ?? job.created_at);
  if (!Number.isFinite(since)) return job;
  if (Date.now() - since < STALL_TIMEOUT_MINUTES * 60_000) return job;

  const { error } = await admin().rpc('reap_stalled_extraction_jobs', {
    stall_timeout: `${STALL_TIMEOUT_MINUTES} minutes`,
  });
  // A failed sweep must not break a status read; the job is reported as-is.
  if (error) {
    console.warn(`[${job.id}] stalled-job sweep failed: ${error.message}`);
    return job;
  }

  const { data: refreshed } = await admin()
    .from('extraction_jobs')
    .select()
    .eq('id', job.id)
    .maybeSingle<JobRow>();

  return refreshed ?? job;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const { data: job, error } = await admin()
      .from('extraction_jobs')
      .select()
      .eq('id', id)
      .maybeSingle<JobRow>();

    if (error) {
      return fail(500, 'LOOKUP_FAILED', `Could not read this job: ${error.message}`);
    }
    if (!job) {
      return fail(404, 'NO_SUCH_JOB', 'This job is not one we have a record of.');
    }

    return Response.json(toStatusResponse(await reapIfStale(job)), {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    if (err instanceof MissingConfigError) {
      return fail(500, 'NOT_CONFIGURED', err.message);
    }
    return fail(
      500,
      'UNEXPECTED',
      `Reading this job failed unexpectedly: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
