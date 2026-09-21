-- Summary counts, so a history list does not have to load every result.
--
-- `result` holds the whole ExtractionResult, which for a 400-page document is
-- megabytes. Listing twenty jobs would mean shipping all of it just to show
-- "24 items, 3 refusals" on each row. Two integers written alongside the
-- result keep the list query small.

alter table public.extraction_jobs
  add column if not exists line_item_count int,
  add column if not exists refusal_count   int;

-- Backfill from the results already stored.
update public.extraction_jobs
   set line_item_count = jsonb_array_length(result -> 'lineItems'),
       refusal_count   = jsonb_array_length(result -> 'refusals')
 where result is not null
   and line_item_count is null;

-- The history list reads newest first and skips uploads that never arrived.
create index if not exists extraction_jobs_history_idx
  on public.extraction_jobs (created_at desc)
  where status <> 'awaiting_upload';
