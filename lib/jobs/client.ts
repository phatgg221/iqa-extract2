/**
 * The browser half of the job flow: create, upload, notify, then watch.
 *
 * Every failure path here produces a specific sentence. A queue adds steps
 * where a reason can go missing — the signed URL, the direct upload, the
 * poll — and each of them has to say what actually happened rather than
 * collapsing into "upload failed".
 */

import { browserClient } from '@/lib/supabase/browser';
import {
  isTerminal,
  type CreatedJob,
  type JobSignal,
  type JobStatusResponse,
  type JobHistoryPage,
} from './types';

/**
 * How often we ask anyway, with Realtime doing the real work.
 *
 * This is not belt-and-braces, it is required for correctness. A broadcast is
 * fire-and-forget with no replay: a message sent before this browser finished
 * subscribing is gone, and so is one sent while the socket was reconnecting.
 * Realtime alone would be *less* reliable than polling, not more. So the
 * subscription makes the page feel instant and this makes it correct.
 */
const BACKSTOP_INTERVAL_MS = 10_000;

/** Generous, but finite: a wait that never gives up is a spinner forever. */
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

/** One page of the upload history. Summaries only — opening one fetches it in full. */
export async function fetchHistory(
  { limit = 20, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<JobHistoryPage> {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const response = await fetch(`/api/jobs?${query}`, { cache: 'no-store' });
  if (!response.ok) throw await reasonFor(response, 'Listing previous uploads');

  const body = await response.json();
  return {
    jobs: Array.isArray(body?.jobs) ? body.jobs : [],
    total: typeof body?.total === 'number' ? body.total : 0,
    limit: typeof body?.limit === 'number' ? body.limit : limit,
    offset: typeof body?.offset === 'number' ? body.offset : offset,
  };
}

/** Re-opens a finished job, result and all. */
export async function loadJob(jobId: string): Promise<JobStatusResponse> {
  return fetchStatus(jobId);
}

export interface SubmitCallbacks {
  onJobCreated?: (jobId: string) => void;
  onUploaded?: () => void;
  onProgress?: (status: JobSignal) => void;
}

/**
 * Listens for a job's progress on a Realtime channel named after its id.
 *
 * Broadcast rather than `postgres_changes` on purpose. Postgres changes are
 * filtered by RLS, and `extraction_jobs` has RLS on with no policies — opening
 * it up for reads would expose every document's extracted contents to anyone
 * holding the publishable key. A channel keyed by the job's UUID is
 * capability-based: knowing the id is already exactly what `GET /api/jobs/{id}`
 * requires, so this is no weaker than what the page could already do.
 */
function watchJob(jobId: string, onSignal: (signal: JobSignal) => void): () => void {
  let channel: ReturnType<ReturnType<typeof browserClient>['channel']> | null = null;

  try {
    const client = browserClient();
    channel = client
      .channel(`job:${jobId}`)
      .on('broadcast', { event: 'update' }, ({ payload }) => {
        if (payload && typeof payload.status === 'string') onSignal(payload as JobSignal);
      });
    channel.subscribe();
  } catch (err) {
    // Realtime is an optimisation. If it cannot start, the backstop still
    // finishes the job, just less promptly.
    console.warn(
      `[${jobId}] could not subscribe for live progress: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return () => {};
  }

  return () => {
    try {
      void browserClient().removeChannel(channel!);
    } catch {
      // Nothing depends on a clean teardown.
    }
  };
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

  return waitForJob(job.jobId, file.name, callbacks);
}

/**
 * Waits for a job to finish, live.
 *
 * The ordering matters. Subscribe first, then read once — anything that
 * happened between the upload and the subscription is only recoverable by that
 * first read. After that, broadcasts drive the progress and the backstop
 * covers whatever the socket misses.
 */
function waitForJob(
  jobId: string,
  fileName: string,
  callbacks: SubmitCallbacks,
): Promise<JobStatusResponse> {
  return new Promise<JobStatusResponse>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      unsubscribe();
      clearInterval(backstop);
      clearTimeout(deadline);
    };
    const finish = (status: JobStatusResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(status);
    };
    const abandon = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    /** Asks the server, which is the only authority on the result. */
    const reconcile = async () => {
      if (settled) return;
      try {
        const status = await fetchStatus(jobId);
        callbacks.onProgress?.(status);
        if (isTerminal(status.status)) finish(status);
      } catch (err) {
        // A blip should not end the wait; the next backstop tick retries.
        // A persistent failure ends at the deadline with a real reason.
        console.warn(
          `[${jobId}] progress check failed: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    const unsubscribe = watchJob(jobId, (signal) => {
      callbacks.onProgress?.(signal);
      // The signal never carries the result, only the news that there is one.
      if (isTerminal(signal.status)) void reconcile();
    });

    const backstop = setInterval(() => void reconcile(), BACKSTOP_INTERVAL_MS);

    const deadline = setTimeout(() => {
      abandon(
        new JobError(
          `${fileName} is still being read after ` +
            `${Math.round(POLL_TIMEOUT_MS / 60000)} minutes, which is longer than ` +
            `expected. It may still finish — the job id is ${jobId} — but this ` +
            `page has stopped waiting for it.`,
          'POLL_TIMEOUT',
        ),
      );
    }, POLL_TIMEOUT_MS);

    void reconcile();
  });
}
