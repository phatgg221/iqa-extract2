/**
 * POST /api/jobs — start an upload.
 *
 * Creates the job row and mints a signed upload token. The PDF itself never
 * passes through this function: the browser PUTs it straight into the bucket.
 * That is the whole point — Vercel caps serverless request bodies at a few
 * megabytes, so a large document routed through here is rejected by the
 * platform before any of our own error handling runs.
 */

import { admin, BUCKET, MissingConfigError } from '@/lib/supabase/admin';
import { toSummary, type CreatedJob, type JobRow } from '@/lib/jobs/types';

export const runtime = 'nodejs';

/** Generous, because the file no longer travels through a function. */
const MAX_BYTES = 200 * 1024 * 1024;

/** How many past uploads the history shows. */
const HISTORY_LIMIT = 20;

/**
 * GET /api/jobs — the upload history.
 *
 * Returns summaries, never results: `result` holds a whole ExtractionResult,
 * which for a long document is megabytes, and twenty of those is not a list.
 * Opening a row fetches that one job in full.
 *
 * Note there is no auth on this service, so this lists every job rather than
 * one person's. That was already true of reading a job by id; listing just
 * makes it easier to find them. It needs an owner column before this is
 * exposed to more than one person.
 */
export async function GET() {
  try {
    const { data, error } = await admin()
      .from('extraction_jobs')
      .select()
      .neq('status', 'awaiting_upload') // uploads that never arrived
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT)
      .returns<JobRow[]>();

    if (error) {
      // The likeliest cause by far, and one the raw message does not explain.
      const missingColumn = /line_item_count|refusal_count/.test(error.message);
      return fail(
        500,
        missingColumn ? 'MIGRATION_MISSING' : 'HISTORY_UNAVAILABLE',
        missingColumn
          ? `The upload history needs database migration 0004, which has not been ` +
            `run yet. Apply supabase/migrations/0004_job_summary_counts.sql and ` +
            `reload. The database reported: ${error.message}`
          : `The upload history could not be read: ${error.message}`,
      );
    }

    return Response.json(
      { jobs: (data ?? []).map(toSummary) },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    if (err instanceof MissingConfigError) {
      return fail(500, 'NOT_CONFIGURED', err.message);
    }
    return fail(
      500,
      'UNEXPECTED',
      `Reading the upload history failed unexpectedly: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface CreateJobBody {
  fileName?: unknown;
  byteSize?: unknown;
  contentType?: unknown;
}

function fail(status: number, code: string, humanMessage: string) {
  return Response.json({ error: { code, humanMessage } }, { status });
}

/** Keeps object keys predictable and free of anything a path could trip on. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'document.pdf';
}

export async function POST(request: Request) {
  let body: CreateJobBody;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'BAD_REQUEST', 'The request body was not valid JSON.');
  }

  const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
  const byteSize = typeof body.byteSize === 'number' ? body.byteSize : NaN;

  if (!fileName) {
    return fail(400, 'NO_FILE_NAME', 'No file name was given, so there is nothing to upload.');
  }
  if (!/\.pdf$/i.test(fileName)) {
    return fail(
      415,
      'NOT_A_PDF',
      `${fileName} is not a PDF. This service only reads PDF documents.`,
    );
  }
  if (!Number.isFinite(byteSize) || byteSize <= 0) {
    return fail(400, 'BAD_SIZE', 'The file size was missing or not a positive number.');
  }
  if (byteSize > MAX_BYTES) {
    return fail(
      413,
      'FILE_TOO_LARGE',
      `${fileName} is ${(byteSize / 1024 / 1024).toFixed(1)} MB, which is over the ` +
        `${MAX_BYTES / 1024 / 1024} MB limit. Try splitting the document.`,
    );
  }

  // One folder per job keeps keys unique without having to dedupe file names,
  // and makes it obvious in the bucket which objects belong together.
  const folderName = crypto.randomUUID();
  const objectKey = `${folderName}/${safeName(fileName)}`;

  try {
    const supabase = admin();

    const { data: job, error: insertError } = await supabase
      .from('extraction_jobs')
      .insert({
        folder_name: folderName,
        object_key: objectKey,
        file_name: fileName,
        byte_size: Math.round(byteSize),
        content_type:
          typeof body.contentType === 'string' ? body.contentType : 'application/pdf',
        status: 'awaiting_upload',
      })
      .select()
      .single<JobRow>();

    if (insertError) {
      return fail(
        500,
        'JOB_NOT_CREATED',
        `The upload could not be registered. The database reported: ${insertError.message}`,
      );
    }

    const { data: signed, error: signError } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(objectKey);

    if (signError || !signed) {
      // Leave no job pointing at a file that can never arrive.
      await supabase.from('extraction_jobs').delete().eq('id', job.id);
      return fail(
        500,
        'UPLOAD_URL_FAILED',
        `An upload location could not be prepared. Storage reported: ` +
          `${signError?.message ?? 'no signed URL was returned'}. ` +
          `Check that the "${BUCKET}" bucket exists.`,
      );
    }

    return Response.json(
      {
        jobId: job.id,
        objectKey,
        uploadToken: signed.token,
        bucket: BUCKET,
      } satisfies CreatedJob,
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof MissingConfigError) {
      return fail(500, 'NOT_CONFIGURED', err.message);
    }
    return fail(
      500,
      'UNEXPECTED',
      `Starting the upload failed unexpectedly: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
