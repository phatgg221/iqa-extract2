# Document extraction

Takes a PDF delivery docket or packing list and returns the line items it could
read, each carrying the page and the exact text it came from, plus a separate
list of everything it declined to extract and why.

The rule the whole thing is built around: **no number is published unless it can
be pointed at on the page.** Refusing is a result. Guessing is not.

**Live:** https://iqa-extract.vercel.app

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # 49 tests, mostly about refusals
```

The deployed service reads text-layer PDFs but **refuses scanned pages**, and
says so — OCR runs only in the local worker, for a reason given below. Run it
locally to see a scan read.

Six sample documents are bundled and can be run from the page itself without
finding a file first.

---

## What the samples turned out to contain

Working out what was actually in each document took as long as building the
extractor, and the design followed from it. Every one carries a specific trap.

| Document | Result |
|---|---|
| `KBS-10234` | Clean. 5 line items, total $2,630.00, nothing refused. |
| `KBS-10241` | Scanned image, no text layer. Refused outright by default; with OCR enabled it is read from the pixels and every figure is marked `OCR` with its confidence. |
| `KBS-10255` | 4 line items with every line total `null` — the document has no Line Total column, so they are left blank rather than multiplied out. The weight column is flagged because `480g total` covers a whole line while `25kg` covers one bag. |
| `KBS-10262` | 3 line items, total $5,122.40 published. Separately flags that the header says 14 pallets and the driver's note says 16. |
| `KBS-10270` | 4 line items extracted. The printed total is $1,612.90, the lines add to $1,538.20; no total is reported and both figures are shown. |
| `KBS-DR118` | 8 pages. Page 4 is a scan: refused by default (21 line items), read by OCR when enabled (24). No document total either way, for the stated reasons. |

### KBS-DR118, in detail

This is the document the whole design is aimed at. Eight pages, and **every
single one carries the identical $669.00** — the same three lines at
10 @ $16.00, 13 @ $17.00, 16 @ $18.00:

```
p1  $669.00  Site 1 of 4 - Ranfurly Ave
p2  $669.00  Site 2 of 4 - Ranfurly Ave     <- same street as Site 1
p3  $669.00  Site 3 of 4 - Beach Road
p4  $669.00  (a scan; readable only by OCR)
p5  $669.00  Summary - Batch Delivery Run 118
p6  $669.00  Returns Note
p7  $669.00  Credit Adjustment
p8  $669.00  Signed Acceptance
```

No page prints a total, and no document total is printed anywhere.

Adding it up gives **$5,352.00**, and that figure is wrong for at least five
independent reasons:

1. **Page 5 is a summary.** A summary restates the site pages, so adding it
   counts the same delivery twice.
2. **Page 6 is a returns note and page 7 a credit adjustment.** That is money
   going *back*. It should reduce the total — but the document never states a
   sign and prints both as positives, so subtracting would be as much a guess
   as adding.
3. **Page 8 is a signed acceptance**, which is a signature copy of a delivery
   rather than a fifth delivery.
4. **Sites 1 and 2 are separate drops at the same street.** Either one is
   mislabelled or the same delivery appears twice.
5. **All eight pages match to the cent.** Four sites receiving byte-identical
   orders is possible; eight pages restating one delivery is likelier.

So the defensible answer is somewhere between **$669.00** (one delivery,
restated eight times) and **$5,352.00** (eight genuine deliveries), and nothing
in the document settles it. A quoting tool that picked any figure in that range
would be confidently wrong by up to eight times.

The service reports **no document total** and states every one of those reasons
in plain language, while still returning all 24 line items with their evidence
so a person can total whichever pages they judge to be real. That is the whole
argument of the project in one document: the extraction is easy, knowing what
the extraction *means* is not, and the honest move is to hand back what is
printed plus the reasons you cannot add it up.

## How it works

A full technical walkthrough — libraries, types, algorithms, the schema and
the measured constants — is in [docs/how-it-works.md](docs/how-it-works.md).
The short version:

```
lib/extract/pdf.ts         PDF -> positioned text cells (the only pdfjs-aware file)
lib/extract/ocr.ts         scanned page -> the same cells, tagged as OCR
lib/extract/png.ts         raw pixels -> PNG, so OCR needs no native canvas
lib/extract/table.ts       cells -> columns and rows, per page
lib/extract/rules.ts       the refusal rules
lib/extract/extract.ts     orchestration, containment, the document-total decision

app/api/extract/route.ts   synchronous route (small files, and the tests)
app/api/jobs/*             create, mark uploaded, status, history
app/api/queues/extract/    Vercel Queues push consumer
worker/index.ts            polling consumer, for local and off-Vercel
lib/jobs/*                 the job contract, the work, the browser flow
supabase/migrations/       jobs table, claim + reap functions, bucket

app/components/            upload, history, results, refusals
```

Extraction is deterministic and geometric. `pdfjs-dist` gives each table cell
as one text item at its column's x origin; column bands are read from each
page's header row, so the same parser handles the usual
`Qty | Unit | Unit Price | Line Total` layout and `KBS-10255`'s
`Qty | Weight | Unit Price` without a special case.

Two things hold the rule in place:

**Evidence is structural, not attached afterwards.** Every published value is a
`Traced<T>`, which cannot be constructed without a page number and the verbatim
source text. There is no way to express "a number we worked out ourselves". A
test walks the entire response, takes every number, and asserts its quoted text
is really printed on the page it cites.

**Arithmetic only detects disagreement; it never supplies a value.** Line totals
are read or `null`. When the printed document total disagrees with the lines,
both are shown and neither is reported as the answer.

**Failures are contained per page.** Each page parses inside its own try/catch,
so one unreadable page costs you that page and nothing else.

### Scanned pages

A page with no text layer is refused by default. Pass an OCR reader and it is
read from its pixels instead:

```ts
import { tesseractOcr } from '@/lib/extract/ocr';
await extract(bytes, fileName, { ocr: tesseractOcr() });
```

The worker enables this unless `OCR_ENABLED=false`. OCR is injected rather than
imported so the core never depends on it — the synchronous route and most tests
never load tesseract at all.

What makes this safe to publish rather than a hole in the rule: OCR produces
the *same* `TextCell` shape as the text-layer reader, so the same positional
parser reads a scan, but every cell is tagged `source: 'ocr'` and carries a
confidence. That flows into the evidence, so the API says which figures were
read off pixels:

```json
{ "value": 160, "evidence": {
    "page": 4, "sourceText": "$160.00", "source": "ocr", "confidence": 95 } }
```

Anything below 80% raises a `LOW_OCR_CONFIDENCE` refusal naming the exact
fields, and the screen badges every OCR'd figure. The value is still shown —
it *is* printed on the page, and hiding our best reading of it would be its own
kind of dishonesty — but it never passes as a figure read from the file.

### The HTTP contract

The status code answers "could we open the document", not "did we like it". A
file read successfully and then refused in full is a **200** with a body of
refusals, because the refusals are the result. Only a file that could never be
opened gets an error status, and the body still carries a real reason.

Every refusal's `humanMessage` is written where the problem is found, because
that is the only place the context still exists. The UI renders it verbatim.

**Copy JSON** and **Download** sit beside the results and hand back the API
response exactly as it was returned — refusals included — so what is on screen
can be checked against what was actually sent.

---

## How this evolved, and what each step was for

Worth reading before the three questions, because most of what I am unsure
about lives in this part rather than in the parser.

### v1 — the file goes through the API

`POST /api/extract`, multipart, parse inline, return JSON. That is what the
brief asks for and it is the right shape for a 2 KB docket. It still exists,
still works, and the 47 tests still cover that path.

### What broke as files grew

Four ceilings, in the order a growing file hits them:

| # | Ceiling | What the user sees |
|---|---|---|
| 1 | **Vercel refuses request bodies over ~4.5 MB** | Rejected by the platform *before our code runs* |
| 2 | Function timeout | Connection dies mid-parse; no partial result, no reason |
| 3 | Whole file plus every page held in memory | The function runs out of memory |
| 4 | Single request/response | A spinner for minutes with nothing behind it |

**Ceiling 1 is the one that actually bites, and it is invisible.** Our own
`MAX_BYTES` check never gets to run, so the specific message *"your file is too
big"* is replaced by a generic platform error on the way out. That is this
project's own thesis biting the project, one layer below where I was looking
for it — which is exactly why it is worth fixing properly rather than raising a
limit.

### v2 — the file stops going through the API

Three changes, each removing one ceiling:

- **A signed upload token.** The browser asks for one, then PUTs the PDF
  straight into a Supabase Storage bucket. Our function only ever handles a few
  hundred bytes of JSON, so **ceiling 1 disappears** — not is raised, disappears.
- **A `extraction_jobs` row is the queue.** A consumer claims it with
  `FOR UPDATE SKIP LOCKED`, downloads from the bucket, and runs the same
  engine. The consumer is not a request, so **ceilings 2 and 3 disappear**.
- **Per-page progress** written as it goes, so **ceiling 4 disappears**.

`lib/extract/` did not change for any of this, apart from one additive option:
`extract()` gained an optional `onPage` callback. The engine is plain
TypeScript with one dependency, so a worker imports it exactly as a route
handler does, and the tested behaviour carried over untouched.

### v3 — push instead of poll, for the consumer

The first version discovered work by polling the table every two seconds. That
is a real process doing real work, but it needs somewhere to run, and Vercel has
no long-lived processes.

So the deployed consumer is a **Vercel Queues** push callback — a route handler
bound to a topic, with no public URL. Delivery is *at least once*, which is the
detail that matters: the consumer never starts work because a message arrived,
it starts work because it **won an atomic claim**. A duplicate delivery gets no
row back and returns without touching the document; a redelivery after a crash
wins it, because a stale `processing` row is exactly what a retry is for.

The polling worker stays, because Queues is beta and because OCR only runs
there. Both call the same `runClaimedJob`, so they cannot drift.

### v4 — push instead of poll, for the browser

The page polled `GET /api/jobs/{id}` every 1.5s. A push queue does not fix that:
Vercel calling our function is server-to-server and tells the browser nothing.

So the browser subscribes to a **Supabase Realtime** broadcast channel named
after the job id, and the consumer publishes a small signal on every transition.
Measured on the eight-page sample: **2 HTTP requests for the whole job** instead
of about 5, with progress arriving every ~0.35s instead of every 1.5s — fast
enough to actually watch each page tick past.

Two decisions inside that are worth more than the speed:

**Broadcast, not `postgres_changes`.** Postgres changes are filtered by RLS, and
`extraction_jobs` has RLS on with no policies. Opening it for reads would hand
every document's extracted contents to anyone holding the publishable key. A
channel keyed by the job's UUID is capability-based — knowing the id is already
exactly what the status endpoint requires.

**A 10s backstop poll remains, and it is required rather than defensive.**
Broadcast is fire-and-forget with no replay, so a message sent before the
browser finished subscribing, or during a reconnect, is simply gone. Realtime
alone would be *less* reliable than polling. The order is: subscribe, read once
to catch anything already missed, then let broadcasts drive it.

### Why this shape holds up with more people using it

The point of moving off a single request was correctness under large files, but
the same shape is what makes more users cheap rather than expensive:

- **Uploads never touch compute.** The bytes go browser → storage on a signed
  token, so upload throughput is a storage problem, not a function-capacity
  one. Twenty people uploading 20 MB files cost the API twenty small JSON
  requests.
- **Work is claimed, not assigned.** `FOR UPDATE SKIP LOCKED` means you add
  consumers and they sort themselves out — no partitioning, no rebalancing, no
  leader. Two consumers or twenty run the same code, and a duplicate delivery
  is already handled because claiming is atomic.
- **The push consumer scales per message.** One invocation per document, so a
  burst is absorbed by the platform rather than queued behind one worker.
- **Realtime removes the load that grows with users.** Polling costs
  *users × duration ÷ interval* requests forever; broadcast costs about two per
  job no matter how many people are watching. That is the difference between a
  page that gets more expensive as the team grows and one that does not.
- **The job row is the queue and the audit trail at once.** Every upload leaves
  a durable record of what was read, what was refused and why — which is what
  you want anyway the first time a customer disputes a quote.

What it would still need before more than one person used it, in order:

1. **Auth, an owner column and RLS policies.** Today any caller can read any
   job and list all of them. This is the blocker, not a nice-to-have.
2. **Back-pressure and per-tenant rate limits**, so one customer's 500-page
   batch cannot starve everyone else.
3. **Cursor paging** on the history, since offset drifts under constant inserts.
4. **A retention policy**, because customer PDFs now persist in a bucket.

### What the queue does not fix

- **A single enormous page still has to fit in memory.** Streaming helps across
  pages, not within one.
- **No resumability.** A consumer dying on page 180 of 200 restarts at page 1,
  because the result is one blob written at the end.
- **No back-pressure.** Nothing stops a hundred uploads queueing at once.
- **Storage and retention.** Customer PDFs now persist in a bucket rather than
  living for one request. That is a data-retention decision, not just an
  engineering one.

The full design note, including the sequence diagram and the open questions, is
in [docs/async-extraction.md](docs/async-extraction.md); how to run it is in
[docs/supabase-setup.md](docs/supabase-setup.md).

---

## The three questions

### The hardest decision

Whether to put a language model in the extraction path.

I chose not to, and instead parse deterministically from text coordinates. The
reason is that it changes what "traceable" means. With a geometric parser,
evidence is a by-product of reading the cell — the number and the string it came
from are the same object, and there is no step at which a value could appear
without one. With an LLM I would be asking a model to return a number *and* a
quote, then verifying the quote afterwards, which means the honest answer to
"can this invent a figure" is "not if the verifier is perfect".

The cost is real and I want to be straight about it: this parser is tuned to one
vendor's template. Hand it a Fletcher's invoice, or a scanned drawing schedule,
and it will not adapt — it will refuse. For an assessment about not guessing, a
system whose failure mode is "declines unfamiliar documents" is the right side
to err on. For a product that has to read whatever a customer uploads, it is
only half an answer, and the other half is in the three-days section below.

The second-hardest decision was withholding `KBS-10270`'s total. It is printed
right there on the page, and returning it with a warning attached would look
more helpful. I withheld it because the person using this is going to put a
number into a quote, and $1,612.90 is either correct or $74.70 too high — I
cannot tell which, and a warning next to a populated field gets dismissed in a
way that an empty field does not.

### Where I'm not confident

Two groups, because they are different kinds of doubt. The parser I have tested
hard against six documents and trust within those limits. The infrastructure
around it I have exercised far less, and that is where I would look first if
something surprised me in production.

**The infrastructure**

- **The deployed path works, but has only been run a handful of times.** I
  drove documents through https://iqa-extract.vercel.app end to end and the
  Vercel Queues consumer read them correctly. What is still unobserved is
  everything past the happy path: I have never seen a redelivery, a duplicate,
  or a consumer crash mid-document in production, so the claim logic that makes
  at-least-once delivery safe is unit-tested and reasoned about rather than
  watched. Queues is also in public beta and `experimentalTriggers` is named
  that for a reason — the polling worker exists partly as insurance.
- **Two consumers racing is real, not theoretical.** While testing prod I had
  local workers still polling the same database, and they silently won some
  jobs — which produced a *better* result than the deployed consumer, because
  they have OCR on. Nothing was corrupted, since claiming is atomic, but it
  means "which consumer read this document" is currently invisible in the
  output. A consumer id on the job row would fix that and I would add it before
  running two for real.
- **OCR does not run in production, and I have tested that rather than assumed
  it.** Tesseract does its work in a spawned worker thread. I first saw it hang
  in `next dev` and inferred the deployed runtime would behave the same, which
  was an assumption; enabling `OCR_ENABLED` on Vercel and pushing the eight-page
  document through confirmed it — the job stalled at page 3 of 8, exactly where
  it reaches the scan, and never moved. So scans are read by the local worker
  and refused on Vercel. The deployed service is meaningfully less capable than
  the local one, which is the single biggest gap in this submission.
- **Nothing was load-tested.** One worker, one document at a time. I have never
  had two consumers race for the same job outside a unit test, and the test I
  would write first is "two concurrent deliveries of one job id produce exactly
  one extraction".
- **The job layer has thin test coverage.** 47 tests, but only a handful touch
  the routes and the claim parsing; nothing covers the worker loop, the
  broadcast, or the Realtime subscription. Two of the bugs I found in that layer
  were found by running it, not by testing it — a worker spinning on a phantom
  job because PostgREST returns a row of nulls rather than null, and a job left
  in `queued` forever because the stalled-job sweep only ran inside the worker
  that was not running.
- **Offset paging drifts.** The upload history pages with `limit`/`offset`,
  which is fine for a list a person reads, but a row arriving mid-read shifts
  everything down a page. A cursor on `created_at` is the correct fix.
- **No auth anywhere.** Any caller can create a job, read any job by id, and
  list every job. The Realtime channel is keyed by an unguessable UUID, which is
  the same capability model the status endpoint already had — but "no worse than
  the existing hole" is not a security model. An owner column and RLS policies
  are the first thing this needs before a second person uses it.
- **Abandoned uploads accumulate.** An `awaiting_upload` row whose file never
  arrives is never cleaned up, and PDFs stay in the bucket forever.

**The parser**

- **Column detection assumes a header row containing "Item" and "Description".**
  Every sample has one. A document that labels its columns differently gets
  `NO_TABLE_FOUND` — it refuses rather than misreads, which is the safe
  direction, but it is a narrow hinge for the whole parser to turn on.
- **OCR is new and lightly proven.** Scanned pages are now read (see below),
  but on exactly one document. The gap threshold that separates columns was
  measured on that one scan, and a differently spaced table could split or
  merge cells wrongly. The 80% confidence bar for trusting a figure is a
  judgement, not a calibrated number.
- **OCR only reads a page that is one whole-page image.** A page assembled
  from several images is refused with that as the reason, rather than stitched
  together.
- **A scanned page loses its heading.** The rules that spot a summary, a
  returns note or a credit adjustment read the page title, and OCR splits that
  line into pieces, so a scanned returns page would be treated as an ordinary
  delivery.
- **Duplicate-page detection is a heuristic.** It flags pages whose amounts match
  to the cent. Two sites that genuinely received identical orders would be
  flagged too. It only ever withholds the total — it never drops line items —
  but on a large run it could withhold a total that was fine.
- **The returns/credit sign rule reads page titles.** A returns note headed
  something else would be silently treated as a normal delivery page. This is
  the weakest rule in the file and the one I would replace first.
- **Prose contradictions only cover four counted nouns** (pallets, cartons,
  packages, bundles) and only digits. "Fourteen pallets" spelled out is missed,
  as is any contradiction about something not on that list. `KBS-10262` passes
  because it happens to say "pallets" twice in digits.
- **`PAGE_PARSE_FAILED` has no test.** The containment path is exercised by
  `KBS-DR118`'s scanned page, but the try/catch around an unexpected parser
  exception is not covered by a fixture, because I could not produce one from
  the samples without fabricating a broken PDF.
- **The 500 handler returns the raw exception message to the client.** That is
  deliberate here — the brief is about real reasons surviving to the screen —
  but it is not what I would ship. In production it would be an error ID plus
  server-side logging, with the message redacted.
- **Only one vendor's documents were ever tested.** Most of the parser section
  follows from that. I have not seen this code meet a document it was not
  written against.

### What I'd do with three more days

1. **Harden the OCR.** It exists now and reads the scanned page correctly, but
   it needs a second and third vendor's scans before I would trust the column
   splitting, a calibrated confidence bar rather than a chosen one, and
   deskewing for anything photographed rather than scanned. Recovering page
   titles from OCR would also restore the summary/returns/credit rules on
   scanned pages.
2. **An LLM as a second reader, never as the source.** Run a model over the same
   pages and compare its line items against the parser's. Where they agree,
   nothing changes. Where they disagree, raise a refusal. The model gets to
   *flag* but never to *supply*, so the traceability guarantee survives intact
   and the parser stops being brittle in silence.
3. **Learned column detection** so a new vendor's template does not need code,
   and a fixture suite per vendor to catch regressions.
4. **A resolution UI.** Most of these refusals are things a person could settle
   in five seconds — is page 5 a duplicate, do the credits subtract, is it 14
   pallets or 16. Right now the refusal is the end of the road; it should be the
   start of a question with an answer that gets remembered for that customer's
   documents.
5. **Prove the deployed path.** Drive documents through the Vercel Queues
   consumer rather than the local worker, write the concurrency test, and either
   get OCR working in a serverless runtime (a worker-thread-free tesseract build
   with its language data bundled) or move it behind a hosted OCR API so the
   deployed service is not the weaker one.
6. **Real error handling at the boundary** as described above — an error ID plus
   server-side logging instead of the raw exception — and an owner column with
   RLS policies so the job endpoints are not open.

---

## Notes

- `samples/` holds the fixtures the tests read; `public/samples/` holds the same
  files so the page can offer them as one-click examples.
- Tests: `npm test`. The ones that matter are in `tests/refusals.test.ts` —
  each pins a case where the correct answer is "we are not going to tell you
  that", plus the two invariants that every number and every refusal quotes
  text really printed on the page it cites.
- The async pipeline needs four migrations applied and a `service_role` key;
  [docs/supabase-setup.md](docs/supabase-setup.md) has the steps and says
  plainly what is verified and what is not. Without any of that,
  `POST /api/extract` still reads a document synchronously.
- Built with Claude Code. The design decisions are mine and I can walk through
  any of them. Several of the ones I am most pleased with came out of being
  wrong first: the traceability invariant and a double-rounding bug in
  `lineArithmeticRefusals` came from writing the tests; the OCR confidence floor
  came from discovering that a 60% bar silently deleted two table columns; and
  the `Evidence.source` field exists because a UI string of mine claimed figures
  were "read directly from the page" on a document where every figure came from
  a scan.
