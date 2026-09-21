/**
 * POST /api/jobs/{id}/uploaded — the browser reports its upload finished.
 *
 * This is what moves a job into the queue. It verifies the object is actually
 * in the bucket first, because a client saying "done" is not evidence that a
 * file arrived, and a worker that claims a job pointing at nothing produces a
 * confusing failure several steps later.
 */

import { admin, BUCKET, MissingConfigError } from '@/lib/supabase/admin';
import type { JobRow } from '@/lib/jobs/types';

export const runtime = 'nodejs';

function fail(status: number, code: string, humanMessage: string) {
  return Response.json({ error: { code, humanMessage } }, { status });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const supabase = admin();

    const { data: job, error } = await supabase
      .from('extraction_jobs')
      .select()
      .eq('id', id)
      .maybeSingle<JobRow>();

    if (error) {
      return fail(500, 'LOOKUP_FAILED', `Could not look up this upload: ${error.message}`);
    }
    if (!job) {
      return fail(404, 'NO_SUCH_JOB', 'This upload is not one we have a record of.');
    }
    // Re-notifying an already queued job is harmless; say so rather than erroring.
    if (job.status !== 'awaiting_upload') {
      return Response.json({ jobId: job.id, status: job.status }, { status: 200 });
    }

    // Confirm the object really landed, rather than trusting the client.
    const folder = job.object_key.split('/')[0];
    const { data: listed, error: listError } = await supabase.storage
      .from(BUCKET)
      .list(folder);

    if (listError) {
      return fail(
        500,
        'STORAGE_UNREACHABLE',
        `The uploaded file could not be verified. Storage reported: ${listError.message}`,
      );
    }

    const expected = job.object_key.slice(folder.length + 1);
    const found = listed?.find((o) => o.name === expected);

    if (!found) {
      return fail(
        409,
        'UPLOAD_NOT_FOUND',
        `${job.file_name} was reported as uploaded, but no such file is in storage. ` +
          `The upload most likely did not finish. Please try again.`,
      );
    }

    const { error: updateError } = await supabase
      .from('extraction_jobs')
      .update({ status: 'queued', uploaded_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'awaiting_upload');

    if (updateError) {
      return fail(
        500,
        'QUEUE_FAILED',
        `The file uploaded but could not be queued for reading: ${updateError.message}`,
      );
    }

    return Response.json({ jobId: job.id, status: 'queued' }, { status: 200 });
  } catch (err) {
    if (err instanceof MissingConfigError) {
      return fail(500, 'NOT_CONFIGURED', err.message);
    }
    return fail(
      500,
      'UNEXPECTED',
      `Queueing this upload failed unexpectedly: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
