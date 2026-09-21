/**
 * The browser half of the job flow: create, upload, notify, poll.
 *
 * Every failure path here produces a specific sentence. A queue adds steps
 * where a reason can go missing — the signed URL, the direct upload, the
 * poll — and each of them has to say what actually happened rather than
 * collapsing into "upload failed".
 */

import { browserClient } from '@/lib/supabase/browser';
import { isTerminal, type CreatedJob, type JobStatusResponse } from './types';

const POLL_INTERVAL_MS = 1500;
/** Generous, but finite: a poll that never gives up is a spinner forever. */
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export class JobError extends Error {
  constructor(
    readonly humanMessage: string,
    readonly code = 'UPLOAD_FAILED',
  ) {
    super(humanMessage);
    this.name = 'JobError';
  }
}

/** Pulls the server's own explanation out of a failed response. */
async function reasonFor(response: Response, fallbackAction: string): Promise<JobError> {
  try {
    const body = await response.json();
    if (typeof body?.error?.humanMessage === 'string') {
      return new JobError(body.error.humanMessage, body.error.code ?? 'UPLOAD_FAILED');
    }
    return new JobError(
      `${fallbackAction} failed with ${response.status} ${response.statusText}, and the ` +
        `server did not explain why. The raw response was: ` +
        `${JSON.stringify(body).slice(0, 300)}`,
    );
  } catch {
    return new JobError(
      `${fallbackAction} failed with ${response.status} ${response.statusText}, and the ` +
        `response could not be read as JSON.`,
    );
  }
}

async function createJob(file: File): Promise<CreatedJob> {
  const response = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
      byteSize: file.size,
      contentType: file.type || 'application/pdf',
    }),
  });

  if (!response.ok) throw await reasonFor(response, 'Registering the upload');
  return response.json();
}

async function uploadToBucket(job: CreatedJob, file: File): Promise<void> {
  const { error } = await browserClient()
    .storage.from(job.bucket)
    .uploadToSignedUrl(job.objectKey, job.uploadToken, file, {
      contentType: file.type || 'application/pdf',
    });

  if (error) {
    throw new JobError(
      `${file.name} could not be uploaded to storage. The upload reported: ` +
        `${error.message}. Nothing has been read; please try again.`,
      'STORAGE_UPLOAD_FAILED',
    );
  }
}

async function markUploaded(jobId: string): Promise<void> {
  const response = await fetch(`/api/jobs/${jobId}/uploaded`, { method: 'POST' });
  if (!response.ok) throw await reasonFor(response, 'Queueing the document');
}

async function fetchStatus(jobId: string): Promise<JobStatusResponse> {
  const response = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
  if (!response.ok) throw await reasonFor(response, 'Checking progress');
  return response.json();
}

export interface SubmitCallbacks {
  onJobCreated?: (jobId: string) => void;
  onUploaded?: () => void;
  onProgress?: (status: JobStatusResponse) => void;
}

/**
 * Runs the whole flow and resolves once the job reaches a terminal state.
 * Resolves for `failed` too — a failure with a reason is an answer, and the
 * caller renders it the same way it renders a result.
 */
export async function submitDocument(
  file: File,
  callbacks: SubmitCallbacks = {},
): Promise<JobStatusResponse> {
  const job = await createJob(file);
  callbacks.onJobCreated?.(job.jobId);

  await uploadToBucket(job, file);
  await markUploaded(job.jobId);
  callbacks.onUploaded?.();

  const deadline = Date.now() + POLL_TIMEOUT_MS;

  for (;;) {
    const status = await fetchStatus(job.jobId);
    callbacks.onProgress?.(status);

    if (isTerminal(status.status)) return status;

    if (Date.now() > deadline) {
      throw new JobError(
        `${file.name} is still being read after ` +
          `${Math.round(POLL_TIMEOUT_MS / 60000)} minutes, which is longer than ` +
          `expected. It may still finish — the job id is ${job.jobId} — but this ` +
          `page has stopped waiting for it.`,
        'POLL_TIMEOUT',
      );
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
