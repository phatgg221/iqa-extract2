-- Reap jobs that were never picked up, not just ones that stalled mid-read.
--
-- The original sweep only looked at 'processing', which assumed something had
-- at least started. A job can also sit in 'queued' forever: the queue gave up
-- redelivering, or no consumer was ever running. Nothing rescued those, so the
-- browser polled until it timed out and the person was told nothing useful.
--
-- A job nobody ever looked at is still a failure, and it still owes an
-- explanation.

create or replace function public.reap_stalled_extraction_jobs(stall_timeout interval default '10 minutes')
returns setof public.extraction_jobs
language sql
as $$
  update public.extraction_jobs
     -- In an UPDATE, column references on the right-hand side are the OLD row,
     -- so `status` here is the state the job was found in.
     set status = 'failed',
         failure_code = case
           when status = 'queued' then 'NEVER_PICKED_UP'
           else 'WORKER_STALLED'
         end,
         failure_message = case
           when status = 'queued' then
             file_name || ' was uploaded successfully but nothing ever started '
             || 'reading it. The document is safe in storage and nothing was '
             || 'extracted from it. This usually means no extraction service was '
             || 'running. Please try uploading it again.'
           else
             'Reading ' || file_name || ' stopped partway through and did not resume. '
             || 'It reached page ' || coalesce(pages_done, 0)::text
             || ' of ' || coalesce(page_count::text, 'an unknown number')
             || ' before the process handling it stopped responding. '
             || 'Nothing was extracted from it. Please upload it again.'
         end,
         finished_at = now()
   where (status = 'processing' and started_at < now() - stall_timeout)
      or (status = 'queued' and coalesce(uploaded_at, created_at) < now() - stall_timeout)
  returning *;
$$;

revoke execute on function public.reap_stalled_extraction_jobs(interval) from public;
revoke execute on function public.reap_stalled_extraction_jobs(interval) from anon, authenticated;
