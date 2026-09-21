/**
 * Local / self-hosted worker.
 *
 * On Vercel, the consumer is `app/api/queues/extract/route.ts` and Vercel
 * pushes work to it. This polling worker is the fallback for everywhere else:
 * local development without `vercel dev`, or a deployment that is not on
 * Vercel at all. Both call the same `runClaimedJob`, so they cannot drift.
 *
 * It claims with `for update skip locked`, so running it alongside the queue
 * consumer is safe — whichever gets there first wins, and the other finds
 * nothing to do.
 *
 * Run it with `npm run worker`.
 */

import { admin } from '@/lib/supabase/admin';
import { asClaimedJob, runClaimedJob } from '@/lib/jobs/process';
import type { JobRow } from '@/lib/jobs/types';

const IDLE_POLL_MS = 2000;
const STALL_TIMEOUT = '10 minutes';

async function claimNext(): Promise<JobRow | null> {
  const { data, error } = await admin().rpc('claim_extraction_job');
  if (error) throw new Error(`could not claim a job: ${error.message}`);
  return asClaimedJob(data);
}

async function reapStalled() {
  const { data, error } = await admin().rpc('reap_stalled_extraction_jobs', {
    stall_timeout: STALL_TIMEOUT,
  });
  if (error) {
    console.warn(`stalled-job sweep failed: ${error.message}`);
    return;
  }
  for (const job of (data as JobRow[] | null) ?? []) {
    console.warn(`[${job.id}] reaped as stalled`);
  }
}

async function main() {
  console.log(`worker started — polling every ${IDLE_POLL_MS}ms`);

  let running = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n${signal} received — finishing the current job then stopping`);
      running = false;
    });
  }

  while (running) {
    try {
      const job = await claimNext();

      if (!job) {
        await reapStalled();
        await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
        continue;
      }

      await runClaimedJob(job);
    } catch (err) {
      // The loop must survive anything, or one bad job stops the queue.
      console.error(
        `worker loop error: ${err instanceof Error ? err.message : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
    }
  }

  console.log('worker stopped');
}

void main();
