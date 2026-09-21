# Running the job pipeline

The async pipeline from [async-extraction.md](./async-extraction.md) is built.
This is how to turn it on.

> **Not yet verified end to end.** The code compiles, typechecks, lints and the
> 29 extraction tests pass, but the pipeline has **not been run against a live
> Supabase project or a live queue**. The CLI on this machine is signed into a
> different account than the project `bmdscdgbjneplmwxdlig`, so the migrations
> could not be applied or exercised from here. Steps 1–3 are yours; step 6 is
> how you confirm it works.

---

## What runs where

| Piece | Where it runs |
|---|---|
| Page + API routes | Vercel (or `next dev`) |
| Uploaded PDFs | Supabase Storage, private `documents` bucket |
| Job state | Supabase Postgres, `extraction_jobs` |
| Message queue | **Vercel Queues**, topic `document-extractions` |
| Consumer (deployed) | [`app/api/queues/extract/route.ts`](../app/api/queues/extract/route.ts) — Vercel pushes to it |
| Consumer (local / off-Vercel) | [`worker/index.ts`](../worker/index.ts) — polls the table |

The file itself never passes through a function: the browser PUTs it straight
into the bucket using a signed token. That is what removes the ~4.5 MB request
body ceiling, which is the limit that actually forces this design.

**Both consumers call the same [`runClaimedJob`](../lib/jobs/process.ts)**, so
they cannot drift. Running them at the same time is safe — claiming is atomic,
so whichever gets there first wins and the other finds nothing to do.

---

## 1. Apply the schema

Open the [SQL editor](https://supabase.com/dashboard/project/bmdscdgbjneplmwxdlig/sql/new)
and run **both** migrations, in order:

1. [`0001_extraction_jobs.sql`](../supabase/migrations/0001_extraction_jobs.sql) —
   the table, `claim_extraction_job()`, `reap_stalled_extraction_jobs()`, and a
   private `documents` bucket.
2. [`0002_claim_job_by_id.sql`](../supabase/migrations/0002_claim_job_by_id.sql) —
   `claim_extraction_job_by_id()`, which is what makes the push consumer safe
   under at-least-once delivery.

Or, from the account that owns the project:

```bash
supabase login
supabase link --project-ref bmdscdgbjneplmwxdlig
supabase db push
```

## 2. Add the secret key

`.env.local` already has the Supabase URL and publishable key. It needs one
more, from **Project Settings → API keys → `service_role`**:

```bash
SUPABASE_SECRET_KEY=<the service_role key>
```

Paste it yourself. It bypasses RLS, it must never carry a `NEXT_PUBLIC_`
prefix, and `.gitignore` already keeps `.env.local` out of git.

## 3. Connect Vercel Queues

The SDK authenticates over OIDC, which means the project has to be linked and
the credentials pulled before `send()` will work locally:

```bash
npm i -g vercel
vercel link
vercel env pull
```

`vercel env pull` appends the OIDC token to `.env.local`. On a deployment this
is automatic and no setup is needed.

> Vercel Queues is in **public beta** and needs to be enabled for your team.
> If it is not, skip this step — see [running without the queue](#running-without-the-queue).

## 4. Run it

```bash
npm run dev
```

With step 3 done, `POST /api/jobs/{id}/uploaded` publishes to the
`document-extractions` topic and Vercel invokes the consumer route. Nothing
else to start.

### Running without the queue

The job row is set to `queued` **before** publishing, and publishing is
best-effort — so if the queue is unavailable, the job is not lost. The polling
worker picks it up instead:

```bash
npm run worker
```

Use this for local development without `vercel dev`, if Queues is not enabled
for your team, or to deploy off Vercel entirely. The response from
`/uploaded` reports `enqueued: true | false` and, on failure, the actual
reason, so you can tell which path a job took.

## 5. Use it

http://localhost:3000 behaves as before — the sample buttons still work — but
the file now goes straight to the bucket and the page reports real progress
(`Reading page 4 of 8`) while the consumer reads it.

## 6. Confirm it actually works

Run the eight-page sample, which exercises everything, and check all four:

| Check | Expected |
|---|---|
| Consumer log | `succeeded — 21 line items, 4 refusals across 8 pages` |
| Storage | A new UUID folder in `documents` holding the PDF |
| `extraction_jobs` row | `status = 'succeeded'`, `pages_done = 8`, `result` populated |
| The page | Page 4 refused, no document total, four refusals — identical to the synchronous version |

If the screen matches what the synchronous version produced, the whole pipeline
is behaving.

---

## At-least-once delivery, and why claiming matters

Vercel Queues guarantees a message arrives **at least** once: duplicates
happen, and a message is redelivered if a consumer crashes or a deployment
rolls out mid-job. So the consumer never starts work just because a message
turned up. It first has to win an atomic claim:

```sql
update public.extraction_jobs
   set status = 'processing', started_at = now(), attempts = attempts + 1
 where id = job_id
   and (status = 'queued'
        or (status = 'processing' and started_at < now() - stall_timeout))
returning *;
```

A duplicate delivery loses that race, gets no row back, and returns without
touching the document. A redelivery *after a crash* wins it, because the stale
`processing` row is exactly what a retry is for.

Two consequences in [`app/api/queues/extract/route.ts`](../app/api/queues/extract/route.ts):

- **Throwing means "redeliver".** It only throws for problems worth retrying,
  such as the database being unreachable. A document read and refused is a
  successful delivery.
- **A malformed message is dropped, not retried.** A message with no `jobId`
  would fail identically forever, so it is logged and acknowledged.

`visibilityTimeoutSeconds` (280) is kept below the function's `maxDuration`
(300) so a message is not redelivered while the first invocation is still
working. Raise both together for large documents.

---

## Keeping refusals alive through the new layers

The queue adds two places where *"page 4 is a scan we cannot read"* can become
*"job failed"*: the job row, and the polling endpoint. Three rules prevent it.

**A refused page is not a failed job.** [`runClaimedJob`](../lib/jobs/process.ts)
marks a job `succeeded` whenever it managed to read the document, even when the
result is nothing but refusals. `failed` is reserved for never having looked at
it — the download failed, or the PDF would not open. Same line the HTTP layer
already drew between a 200-with-refusals and a 4xx.

**`failure_message` is written where the failure happens.** The consumer
composes the sentence, because that is where the context is. `toStatusResponse`
passes it through and the page renders it verbatim.

**A stalled job says so.** `reap_stalled_extraction_jobs()` turns a job whose
consumer died into a `failed` job whose message names the page it reached, and
the browser stops polling after ten minutes. A silent hang is the worst kind of
generic error.

---

## The pieces

| File | Role |
|---|---|
| [`0001_extraction_jobs.sql`](../supabase/migrations/0001_extraction_jobs.sql) | Table, queue functions, bucket |
| [`0002_claim_job_by_id.sql`](../supabase/migrations/0002_claim_job_by_id.sql) | Atomic claim by id, for push delivery |
| [`lib/supabase/admin.ts`](../lib/supabase/admin.ts) | Service-role client — server and consumers only |
| [`lib/supabase/browser.ts`](../lib/supabase/browser.ts) | Publishable client — only PUTs to a signed token |
| [`lib/jobs/types.ts`](../lib/jobs/types.ts) | Job contract shared by all sides |
| [`lib/jobs/process.ts`](../lib/jobs/process.ts) | The work itself — shared by both consumers |
| [`lib/jobs/client.ts`](../lib/jobs/client.ts) | Browser flow: create → upload → notify → poll |
| [`app/api/jobs/route.ts`](../app/api/jobs/route.ts) | Creates the row, mints the upload token |
| [`app/api/jobs/[id]/uploaded/route.ts`](../app/api/jobs/[id]/uploaded/route.ts) | Verifies the object, queues it, publishes the message |
| [`app/api/jobs/[id]/route.ts`](../app/api/jobs/[id]/route.ts) | Status, progress, result or failure |
| [`app/api/queues/extract/route.ts`](../app/api/queues/extract/route.ts) | Push consumer (Vercel) |
| [`worker/index.ts`](../worker/index.ts) | Polling consumer (local / off-Vercel) |
| [`vercel.json`](../vercel.json) | Binds the consumer route to the topic |

**`lib/extract/` did not change**, apart from one additive option: `extract()`
now takes an optional `onPage` callback so progress can be reported. The engine
and all 29 tests are otherwise untouched — it is plain TypeScript with one
dependency, so a route handler and a worker can both import it.

---

## Security notes

- **RLS is on with no policies**, denying `anon` and `authenticated` entirely.
  All access is via the service role from our own server. When auth arrives,
  add an owner column and owner-scoped policies rather than opening the table.
- **All three queue functions are `security invoker`** with `execute` revoked
  from `public`, `anon` and `authenticated`. Postgres grants `execute` to
  `PUBLIC` on every new function by default, so without those revokes anyone
  holding the publishable key could seize or drain jobs.
- **The bucket is private** with no policies. Uploads are authorised by a
  server-minted signed token.
- **The consumer route has no public URL.** The `vercel.json` trigger makes it
  invokable only by Vercel's queue infrastructure.
- **The secret key never reaches the browser.** `admin.ts` is imported only by
  route handlers and the worker.

---

## Reading scanned pages

A page with no text layer is refused by default. The **worker** reads it with
OCR instead — `npm run worker` sets `OCR_ENABLED=true`.

It is deliberately not enabled anywhere else, and that is a constraint rather
than a preference: tesseract does its work in a spawned worker thread, which
never starts inside a Next.js route handler. The call simply never returns, and
the symptom is a job stuck in `processing` until the stalled-job sweep catches
it ten minutes later. So:

| Path | Scanned pages |
|---|---|
| `npm run worker` | read by OCR, every figure marked with its confidence |
| Vercel Queues consumer | refused, exactly as before |
| `POST /api/extract` | refused, exactly as before |

OCR is also bounded to 60 seconds per page, so even if the engine does wedge,
the page becomes a refusal rather than a hung job.

Enabling it on the serverless consumer would need a build of tesseract that
does not depend on worker threads, plus the language data bundled into the
function — otherwise every cold start re-downloads roughly 15 MB.

## Deploying

One gotcha that only shows up in production. `serverExternalPackages`
tells Vercel to trace `pdfjs-dist` from `node_modules` rather than bundle it,
but tracing follows *static* imports — and pdfjs pulls in its worker through a
**dynamic** import when it sets up the fake worker in Node. The tracer never
sees it, so the deployed function is missing the file and every upload fails
with:

```
Setting up fake worker failed: "Cannot find module
'/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'"
```

It works perfectly locally, because `node_modules` is right there on disk.

The fix is in [`next.config.ts`](../next.config.ts):

```ts
outputFileTracingIncludes: {
  "/api/**": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
},
```

To confirm it before deploying, build and check the trace manifests:

```bash
npx next build
grep -l pdf.worker.mjs .next/server/app/api/**/*.nft.json
```

Every API route that reads a PDF should be listed. Nothing listed means the
worker will be missing in production.

## Still not done

- **Not run against a live project or a live queue.** Likeliest first snags:
  the bucket insert needing dashboard permissions, Queues not being enabled for
  the team, or `claim_extraction_job_by_id` returning a shape the client reads
  differently than expected.
- **Vercel Queues is beta**, and `experimentalTriggers` is named that for a
  reason. The polling worker exists partly as insurance against that.
- **No tests for the job layer.** The 29 extraction tests still pass, but
  nothing covers the routes, the consumers, or the claim functions. The test
  worth writing first: two concurrent deliveries of the same job id result in
  exactly one extraction.
- **No auth**, so any caller can create a job and read any job by id.
- **No cleanup.** Abandoned `awaiting_upload` rows and orphaned objects
  accumulate; PDFs stay in the bucket forever.
- **Retries are only as good as the stall timeout.** A crashed job is not
  retried until it goes stale, because nothing signals the crash.
- **No resumability.** A consumer dying on page 180 of 200 restarts at page 1,
  since the result is one blob written at the end.
- **`POST /api/extract` still exists** and still works synchronously. Useful
  for small files and the tests, but two paths to the same result is something
  to resolve, not a feature.
