-- Claiming a specific job, for push-based delivery.
--
-- Vercel Queues delivers at least once: the same message can arrive twice, and
-- will be redelivered if a consumer crashes. So the consumer cannot just start
-- working when a message shows up — it has to win an atomic claim first, and
-- do nothing if someone else already has the job.
--
-- This is the same guard `claim_extraction_job()` provides for the polling
-- worker, narrowed to one id.

create or replace function public.claim_extraction_job_by_id(
  job_id uuid,
  stall_timeout interval default '10 minutes'
)
returns public.extraction_jobs
language sql
as $$
  update public.extraction_jobs
     set status     = 'processing',
         started_at = now(),
         attempts   = attempts + 1
   where id = job_id
     and (
       status = 'queued'
       -- A redelivery after the previous attempt died mid-document is exactly
       -- the case retries exist for, so let it through once the job is stale.
       or (status = 'processing' and started_at < now() - stall_timeout)
     )
  returning *;
$$;

-- Postgres grants execute to PUBLIC on every new function, and anon inherits
-- from PUBLIC, so without this anyone with the publishable key could seize a job.
revoke execute on function public.claim_extraction_job_by_id(uuid, interval) from public;
revoke execute on function public.claim_extraction_job_by_id(uuid, interval) from anon, authenticated;
