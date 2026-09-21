/**
 * Vercel Queues consumer for the `document-extractions` topic.
 *
 * This route has no public URL — only Vercel's queue infrastructure can invoke
 * it, via the trigger declared in `vercel.json`. It is the deployed equivalent
 * of `worker/index.ts`, and both call the same `runClaimedJob`.
 *
 * Two things follow from at-least-once delivery:
 *
 *   1. The handler must be idempotent. It is, because `processJobById` has to
 *      win an atomic claim before it does any work — a duplicate delivery
 *      loses that race and returns without touching the document.
 *
 *   2. Throwing means "redeliver". So we only throw while retrying could still
 *      help, and we stop before the platform's own limit — because a message
 *      the queue quietly gives up on leaves the job sitting in `queued` with
 *      nobody to explain it, which is precisely the silent failure this
 *      project exists to avoid.
 */

import { handleCallback } from '@vercel/queue';
import { failJobById, processJobById } from '@/lib/jobs/process';

export const runtime = 'nodejs';

/**
 * Reading a long PDF is slow. Raise this toward the platform maximum if you
 * start handling large documents — and keep `visibilityTimeoutSeconds` below
 * it, so the message is not redelivered while this invocation is still working.
 */
export const maxDuration = 300;

/**
 * Deliberately below the platform's redelivery limit, so that we are the ones
 * who decide to give up and can write down why. Five attempts is well past the
 * point where a transient fault would have cleared.
 */
const MAX_DELIVERIES = 5;

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

    try {
      const result = await processJobById(jobId);
      if (result.outcome === 'skipped') {
        console.log(`[${jobId}] delivery ignored — ${result.reason}`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);

      if (metadata.deliveryCount < MAX_DELIVERIES) {
        throw err; // still worth another go
      }

      // Out of retries. Put the real reason on the job rather than letting the
      // queue drop the message silently, then return so it is acknowledged:
      // continuing to retry would only repeat a failure nobody is watching.
      await failJobById(
        jobId,
        'EXTRACTION_UNAVAILABLE',
        `This document could not be read after ${metadata.deliveryCount} attempts. ` +
          `The extraction service reported: ${reason}. The document is safe in ` +
          `storage — nothing was extracted from it, and nothing has been guessed. ` +
          `This needs someone to look at the service rather than the document.`,
      );
    }
  },
  { visibilityTimeoutSeconds: 280 },
);
