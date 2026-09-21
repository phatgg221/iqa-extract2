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

    return Response.json(toStatusResponse(job), {
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
