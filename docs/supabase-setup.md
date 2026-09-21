# Running the job pipeline

The async pipeline described in [async-extraction.md](./async-extraction.md) is
now built. This is how to turn it on.

> **Not yet verified end to end.** The code compiles, typechecks, lints and the
> 29 extraction tests pass, but the pipeline has **not been run against a live
> Supabase project**. The CLI on this machine is signed into a different
> account than the project `bmdscdgbjneplmwxdlig`, so the migration could not
> be applied or exercised from here. Steps 1–2 below are the ones to do first,
> and step 5 is how you confirm it actually works.

---

## 1. Apply the schema

Open the [SQL editor](https://supabase.com/dashboard/project/bmdscdgbjneplmwxdlig/sql/new)
for the project, paste the contents of
[`supabase/migrations/0001_extraction_jobs.sql`](../supabase/migrations/0001_extraction_jobs.sql),
and run it.

It creates:

- the `extraction_jobs` table, with RLS on and **no policies**
- `claim_extraction_job()` — the `for update skip locked` queue
- `reap_stalled_extraction_jobs()` — fails jobs whose worker died, with a reason
- a **private** `documents` storage bucket

If you would rather use the CLI, sign in to the account that owns the project
and link it first:

```bash
supabase login
supabase link --project-ref bmdscdgbjneplmwxdlig
supabase db push
```

## 2. Add the secret key

`.env.local` already has the URL and publishable key. It needs one more value,
from **Project Settings → API keys → `service_role`**:

```bash
SUPABASE_SECRET_KEY=<the service_role key>
```

Paste it into `.env.local` yourself — it is a secret that bypasses RLS, it must
never carry a `NEXT_PUBLIC_` prefix, and `.gitignore` already keeps
`.env.local` out of git.

## 3. Run both processes

Two terminals. The app serves the page and the API; the worker does the reading.

```bash
npm run dev
```

```bash
npm run worker
```

The worker logs each job it claims, its progress, and why anything failed.

## 4. Use it

http://localhost:3000 behaves as before — the sample buttons still work — but
the file now goes straight to the bucket and the page reports real progress
(`Reading page 4 of 8`) while the worker reads it.

## 5. Confirm it actually works

Run the eight-page sample, which is the one that exercises everything, and
check all four:

| Check | Expected |
|---|---|
| Worker log | `claimed KBS-DR118.pdf` then `succeeded — 21 line items, 4 refusals across 8 pages` |
| Storage | A new folder (a UUID) in the `documents` bucket holding the PDF |
| `extraction_jobs` row | `status = 'succeeded'`, `pages_done = 8`, `result` populated |
| The page | Same output as the synchronous version: page 4 refused, no document total, four refusals |

If the result on screen matches what the synchronous version produced, the
whole pipeline is behaving.

---

## How the pieces fit

| File | Role |
|---|---|
| [`supabase/migrations/0001_extraction_jobs.sql`](../supabase/migrations/0001_extraction_jobs.sql) | Table, queue functions, bucket |
| [`lib/supabase/admin.ts`](../lib/supabase/admin.ts) | Service-role client — server and worker only |
| [`lib/supabase/browser.ts`](../lib/supabase/browser.ts) | Publishable client — only used to PUT to a signed token |
| [`lib/jobs/types.ts`](../lib/jobs/types.ts) | Job contract shared by all three sides |
| [`lib/jobs/client.ts`](../lib/jobs/client.ts) | Browser flow: create → upload → notify → poll |
| [`app/api/jobs/route.ts`](../app/api/jobs/route.ts) | `POST` — creates the row, mints the signed upload token |
| [`app/api/jobs/[id]/uploaded/route.ts`](../app/api/jobs/[id]/uploaded/route.ts) | `POST` — verifies the object landed, then queues it |
| [`app/api/jobs/[id]/route.ts`](../app/api/jobs/[id]/route.ts) | `GET` — status, progress, result or failure |
| [`worker/index.ts`](../worker/index.ts) | Claims, downloads, extracts, writes back |

**`lib/extract/` did not change**, apart from one additive option: `extract()`
now takes an optional `onPage` callback so the worker can report progress. The
engine and all 29 tests are otherwise untouched, which is the point — it is
plain TypeScript with one dependency, so a worker can import it as easily as a
route handler could.

---

## Keeping refusals alive through two new layers

A queue adds two places where *"page 4 is a scan we cannot read"* can become
*"job failed"*: the job row, and the polling endpoint. Three things prevent
that:

**A refused page is not a failed job.** The worker marks a job `succeeded`
whenever it managed to read the document, even if the result is nothing but
refusals — see [`worker/index.ts`](../worker/index.ts). `failed` is reserved
for never having looked at the document at all: the download failed, or the
PDF would not open. This is the same line the HTTP layer already drew between
a 200-with-refusals and a 4xx.

**`failure_message` is written where the failure happens.** The worker composes
the sentence, because the worker is where the context is. `toStatusResponse`
in [`lib/jobs/types.ts`](../lib/jobs/types.ts) passes it through, and the page
renders it verbatim. No layer in between summarises it.

**A stalled job says so.** `reap_stalled_extraction_jobs()` turns a job whose
worker died into a `failed` job whose message names the page it reached. The
browser also stops polling after ten minutes rather than spinning forever.

---

## Security notes

- **RLS is on with no policies**, which denies `anon` and `authenticated`
  entirely. All access is via the service role from our own server. When auth
  arrives, add an owner column and owner-scoped policies rather than opening
  the table.
- **Both queue functions are `security invoker`** and have `execute` revoked
  from `public`, `anon` and `authenticated`. Postgres grants `execute` to
  `PUBLIC` on every new function by default, so without those revokes anyone
  holding the publishable key could drain the queue.
- **The bucket is private** and has no policies. Uploads are authorised by a
  signed token minted server-side, so the token carries the permission and
  nothing else can read or write the objects.
- **The secret key never reaches the browser.** `lib/supabase/admin.ts` is
  imported only by route handlers and the worker.

---

## Still not done

- **Not run against a live project.** See the note at the top. Most likely
  first snags: the bucket insert needing dashboard permissions, or
  `claim_extraction_job` returning a shape the client reads differently than
  expected.
- **No tests for the job layer.** The 29 extraction tests still pass and still
  matter, but nothing covers the routes, the worker, or the claim function. A
  test that two concurrent workers never claim the same job is the one worth
  writing first.
- **No auth**, so any caller can create a job and read any job by id.
- **No cleanup.** Abandoned `awaiting_upload` rows and their orphaned objects
  accumulate; nothing expires them, and PDFs stay in the bucket forever.
- **No retries.** `attempts` is incremented but nothing acts on it.
- **`POST /api/extract` still exists** and still works synchronously. It is
  useful for small files and for the tests, but having two paths to the same
  result is a thing to resolve, not a feature.
- **Still no resumability.** A worker dying on page 180 of 200 restarts at
  page 1, because the result is one blob written at the end.
