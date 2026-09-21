-- Extraction jobs: one row per uploaded document.
--
-- The table is the queue. For one worker and a handful of concurrent uploads,
-- `for update skip locked` is a correct queue with no extra infrastructure,
-- and the claim and the job state live in the same transactional row.

create table if not exists public.extraction_jobs (
  id uuid primary key default gen_random_uuid(),

  -- Where the file lives in the bucket.
  folder_name  text   not null,
  object_key   text   not null unique,
  file_name    text   not null,
  byte_size    bigint not null check (byte_size > 0),
  content_type text,

  -- Job state.
  status      text not null default 'awaiting_upload'
    check (status in ('awaiting_upload', 'queued', 'processing', 'succeeded', 'failed')),
  page_count  int,
  pages_done  int not null default 0,

  -- The ExtractionResult, written once on success.
  result jsonb,

  -- A refusal-shaped failure. `failure_message` is the sentence a person reads,
  -- written by the worker where the context exists, and passed through
  -- unchanged by every layer above it.
  failure_code    text,
  failure_message text,

  attempts int not null default 0,

  created_at  timestamptz not null default now(),
  uploaded_at timestamptz,
  started_at  timestamptz,
  finished_at timestamptz
);

-- Supports both the claim query and the stalled-job sweep.
create index if not exists extraction_jobs_pending_idx
  on public.extraction_jobs (status, created_at)
  where status in ('queued', 'processing');

-- Row Level Security -------------------------------------------------------
--
-- RLS is on with no policies, which denies anon and authenticated entirely.
-- Every read and write goes through our own API routes using the service role,
-- which bypasses RLS. When auth lands, add an owner column and owner-scoped
-- policies rather than opening this table up.

alter table public.extraction_jobs enable row level security;

-- Claiming a job ------------------------------------------------------------
--
-- security invoker (the default) on purpose: the worker authenticates with the
-- service role, so the function does not need to escalate. A security definer
-- function here would be callable by anyone able to reach the Data API.

create or replace function public.claim_extraction_job()
returns public.extraction_jobs
language sql
as $$
  update public.extraction_jobs
     set status     = 'processing',
         started_at = now(),
         attempts   = attempts + 1
   where id = (
     select id
       from public.extraction_jobs
      where status = 'queued'
      order by created_at
      for update skip locked
      limit 1
   )
  returning *;
$$;

-- Postgres grants execute to PUBLIC on every new function, and anon and
-- authenticated inherit from PUBLIC, so without this the queue would be
-- drainable by anyone holding the publishable key.
revoke execute on function public.claim_extraction_job() from public;
revoke execute on function public.claim_extraction_job() from anon, authenticated;

-- Reaping stalled jobs ------------------------------------------------------
--
-- A worker that dies mid-document leaves a row in 'processing' forever. A job
-- that hangs silently is the worst version of a generic error, so it is failed
-- explicitly with a reason someone can act on.

create or replace function public.reap_stalled_extraction_jobs(stall_timeout interval default '10 minutes')
returns setof public.extraction_jobs
language sql
as $$
  update public.extraction_jobs
     set status = 'failed',
         failure_code = 'WORKER_STALLED',
         failure_message =
           'Reading this document stopped partway through and did not resume. '
           || 'It reached page ' || coalesce(pages_done, 0)::text
           || ' of ' || coalesce(page_count::text, 'an unknown number')
           || ' before the process handling it stopped responding. '
           || 'Nothing was extracted from it. Please upload it again.',
         finished_at = now()
   where status = 'processing'
     and started_at < now() - stall_timeout
  returning *;
$$;

revoke execute on function public.reap_stalled_extraction_jobs(interval) from public;
revoke execute on function public.reap_stalled_extraction_jobs(interval) from anon, authenticated;

-- Storage -------------------------------------------------------------------
--
-- A private bucket. Uploads are authorised by a signed token minted server
-- side, so the bucket needs no anon policies: the token itself carries the
-- permission, and nothing else can read or write the objects.

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;
