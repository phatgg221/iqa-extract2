/**
 * Vercel Queues consumer for the `document-extractions` topic.
 *
 * This route has no public URL — only Vercel's queue infrastructure can invoke
 * it, via the trigger declared in `vercel.json`. It is the deployed equivalent
 * of `worker/index.ts`, and both call the same `processJobById`.
 *
 * Two things follow from at-least-once delivery:
 *
 *   1. The handler must be idempotent. It is, because `processJobById` has to
 *      win an atomic claim before it does any work — a duplicate delivery
 *      loses that race and returns without touching the document.
 *
 *   2. Throwing is meaningful. An exception tells Vercel to redeliver, so we
 *      only throw for problems worth retrying (the database was unreachable).
 *      A document we read and refused is a successful delivery.
 */

import { handleCallback } from '@vercel/queue';
import { processJobById } from '@/lib/jobs/process';

export const runtime = 'nodejs';

/**
 * Reading a long PDF is slow. Raise this toward the platform maximum if you
 * start handling large documents — and keep `visibilityTimeoutSeconds` below
 * it, so the message is not redelivered while this invocation is still working.
 */
export const maxDuration = 300;

interface ExtractionMessage {
  jobId?: unknown;
}

export const POST = handleCallback<ExtractionMessage>(
  async (message, metadata) => {
    const jobId = typeof message?.jobId === 'string' ? message.jobId : null;

    if (!jobId) {
      // Unfixable by retrying: a malformed message would fail identically
      // every time, so it is logged and acknowledged rather than redelivered.
      console.error(
        `[queue] message ${metadata.messageId} carried no jobId and was dropped: ` +
          `${JSON.stringify(message).slice(0, 200)}`,
      );
      return;
    }

    const result = await processJobById(jobId);

    if (result.outcome === 'skipped') {
      console.log(`[${jobId}] delivery ignored — ${result.reason}`);
    }
  },
  { visibilityTimeoutSeconds: 280 },
);
