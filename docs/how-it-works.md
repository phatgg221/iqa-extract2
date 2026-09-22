# How it works

A technical walkthrough: the libraries, the types, the algorithms, and the
reasoning behind each. The short version of the argument is in the
[README](../README.md); this is the detail underneath it.

---

## The stack, and why each piece

| Library | Version | Why this one |
|---|---|---|
| `next` | 16.3.5 | App Router. One deployable for the page and the API, and it matches the team's stack. |
| `pdfjs-dist` | 4.10.38 | The only PDF library that gives **per-item x/y coordinates** in Node without a native build. `pdf-parse` returns a flat string — no positions, so no evidence. `pdfplumber` is Python. |
| `tesseract.js` | 7.0.0 | OCR with **per-word bounding boxes and confidence**, pure WASM, no system binary. Confidence is the part that matters: it is what lets a figure be reported *and* doubted. |
| `@supabase/supabase-js` | 2.116.0 | Storage (signed upload tokens) and Postgres. |
| `@vercel/queue` | 0.6.0 | Push-based delivery, so no long-running consumer is needed on Vercel. |
| `vitest` | 5.0.1 | Fast, native TS/ESM, no Babel config. |
| `tsx` | 4.23.15 | Runs the worker as TypeScript with `tsconfig` path aliases. |

**No LLM, and no document-AI API.** That is the central decision; the reasoning
is in the README under "the hardest decision".

Roughly 2,900 lines of source across `lib/`, `worker/` and the API routes.

---

## The type contract

Everything hangs off one idea, in [`lib/extract/types.ts`](../lib/extract/types.ts):

```ts
export interface Evidence {
  page: number;
  /** Copied verbatim off the page, or as OCR read it. */
  sourceText: string;
  source: 'text-layer' | 'ocr';
  /** 0-100. Present only for OCR. */
  confidence?: number;
}

/** A value that knows where it came from. The only way to publish a number. */
export interface Traced<T> {
  value: T;
  evidence: Evidence;
}
```

`Traced<T>` cannot be constructed without evidence, and evidence cannot be
constructed without saying whether it was read from the file or guessed from
pixels. **There is deliberately no type that expresses "a number we worked out
ourselves."** That is the rule, enforced by the compiler rather than by
discipline.

A line item is therefore a bundle of optional traced values:

```ts
export interface LineItem {
  page: number;
  /** The number printed in the Item column, not our own index. */
  lineNumber: number;
  description: Traced<string>;
  quantity: Traced<number> | null;
  unit: Traced<string> | null;
  unitPrice: Traced<number> | null;
  /** Null when the document does not print a line total. Never computed. */
  lineTotal: Traced<number> | null;
}
```

`null` means *the document does not say*. It never means zero, and it is never
filled in by multiplying two other fields.

And the counterpart — what we decline, and why:

```ts
export interface Refusal {
  scope: 'document' | 'page' | 'line' | 'field';
  code: RefusalCode;
  page: number | null;
  lineNumber: number | null;
  field: string | null;
  humanMessage: string;   // written here, rendered verbatim, never summarised
  evidence: Evidence[];
}
```

`humanMessage` is composed at the point the problem is found, because that is
the only place the context still exists. Every layer above passes it through
untouched.

### The thirteen refusal codes

| Code | Raised when |
|---|---|
| `NO_TEXT_LAYER` | Page is a scan. Message distinguishes OCR-off / OCR-failed / OCR-found-nothing. |
| `PAGE_PARSE_FAILED` | A page threw. Contained; other pages still return. |
| `NO_TABLE_FOUND` | Text, but no recognisable line-item header. |
| `VALUE_NOT_PRINTED` | The document has no such column. `KBS-10255` has no Line Total. |
| `UNPARSEABLE_VALUE` | A cell exists but is not a clean number. |
| `LINE_ARITHMETIC_MISMATCH` | qty × price ≠ printed line total. |
| `DOCUMENT_TOTAL_MISMATCH` | Printed total ≠ sum of lines. `KBS-10270`. |
| `DOCUMENT_TOTAL_ABSENT` | No total printed, and we will not sum one. |
| `CONTRADICTORY_STATEMENT` | The document disagrees with itself. 14 vs 16 pallets; two sites, one address. |
| `AMBIGUOUS_UNIT_SEMANTICS` | A column changes meaning down the page. `480g total` vs `25kg`. |
| `SIGN_UNDETERMINED` | Returns/credits whose sign is never stated. |
| `POSSIBLE_DUPLICATE_PAGE` | Pages with byte-identical amounts. |
| `LOW_OCR_CONFIDENCE` | An OCR'd figure below 80%. |

---

## Stage 1 — PDF to positioned cells

[`lib/extract/pdf.ts`](../lib/extract/pdf.ts) is the only file that imports
pdfjs. Everything downstream works on plain structs, which is what makes the
parser testable without a PDF.

```ts
export interface TextCell {
  text: string;
  x: number;   // points from the left
  y: number;   // points from the bottom (higher = nearer the top)
  source: 'text-layer' | 'ocr';
  confidence?: number;
  words?: { text: string; x: number }[];  // OCR only
}
```

The extraction itself:

```ts
const content = await page.getTextContent();
for (const item of content.items) {
  if (!('str' in item)) continue;              // marked-content nodes
  cells.push({
    text: item.str.trim(),
    x: item.transform[4],                       // the affine matrix's e
    y: item.transform[5],                       //                    f
    source: 'text-layer',
  });
}
```

`item.transform` is a 6-element affine matrix `[a,b,c,d,e,f]`; indices 4 and 5
are the translation, i.e. where the text sits on the page.

**The discovery that shaped the design:** pdfjs returns each *table cell* as
one item anchored at its column's x-origin, not one item per word:

```
y=643  1@43 | Galv nails 90mm, bulk@71 | 4@312 | 25kg@377 | $68.00 /bag@468
```

So `sourceText` is already exactly the string printed on the page. Evidence is
a by-product of reading the cell, not something reconstructed afterwards.

---

## Stage 2 — Cells to a structured page

[`lib/extract/table.ts`](../lib/extract/table.ts), 284 lines. Four steps.

### 2a. Group cells into rows

```ts
const ROW_TOLERANCE = 2;   // points
```

Cells are sorted by `y` descending and bucketed within ±2pt. Text-layer
baselines are exact so this is generous; OCR needed separate handling (below).

### 2b. Find the header

```ts
const line = rows[i].cells.map((c) => c.text.toLowerCase()).join(' ');
if (/\bitem\b/.test(line) && /\bdescription\b/.test(line)) return { row: rows[i], index: i };
```

Matched against the **whole row** rather than individual cells, because OCR can
run two labels together — see 6d.

### 2c. Derive column origins from the header

```ts
const HEADER_LABELS: Record<string, ColumnKey> = {
  item: 'item',            description: 'description',
  qty: 'qty',              quantity: 'qty',
  unit: 'unit',            weight: 'weight',
  'unit price': 'unitPrice', 'line total': 'lineTotal',
};
```

Read from each page, never hardcoded — because the documents genuinely differ:

| Document | Columns |
|---|---|
| Most | `Item(43) Description(71) Qty(326) Unit(377) Unit Price(428) Line Total(502)` |
| `KBS-10255` | `Item(43) Description(71) Qty(312) Weight(377) Unit Price(468)` |

### 2d. Assign cells to columns

```ts
const COLUMN_SNAP = 3;   // points of tolerance to the left

// Cells are left-aligned on their column, so the nearest origin
// at or left of the cell wins.
for (const column of columns) {
  if (cell.x >= column.x - COLUMN_SNAP && (!match || column.x > match.x)) match = column;
}
```

A row becomes a line item only if its `item` cell is a bare integer **and** it
has a description. That one predicate excludes totals rows, prose and
separators without special-casing any of them.

### Totals rows come in two shapes

Found by probing, not by assumption:

```
KBS-10234:  [337]Total:            [502]$2,630.00     ← two cells
KBS-10262:  [43]Total: $5,122.40                      ← one cell, inline
```

Handling only the first would have silently dropped 10262's total and emitted
a false "no total printed" refusal. A third case — `Total consignment weight:
see individual lines.` — matches `/^total\b/i` but yields no amount, and is
recorded separately so the refusal can say *why* there is no total.

---

## Stage 3 — Strict scalar parsing

[`lib/extract/money.ts`](../lib/extract/money.ts), 80 lines of deliberately
unforgiving regexes.

```ts
const MONEY           = /^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/;
const QUANTITY        = /^(\d+(?:\.\d+)?)$/;
const MONEY_WITH_UNIT = /^(\$?\s*(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d{1,2})?)\s*\/\s*([A-Za-z]+)$/;
const TRAILING_MONEY  = /\$\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/;
```

Being lenient here is how `480g total` quietly becomes a quantity of 480.
`QUANTITY` rejects anything with a unit or a word, so it returns `null` — and
`null` is a useful answer.

`MONEY_WITH_UNIT` handles `$68.00 /bag`, where the unit is only recoverable
from the price string because the document has no Unit column.

**All money comparisons are in integer cents.** Comparing dollars as floats
makes `1195.2 !== 1195.2000000000003` and invents mismatches that are not in
the document.

---

## Stage 4 — The refusal rules

[`lib/extract/rules.ts`](../lib/extract/rules.ts), 289 lines. Every rule reads
what was parsed and emits refusals; **no rule ever repairs a value.**

### Line arithmetic

```ts
// Multiply before converting to cents. Rounding the unit price first would
// turn a sub-cent price like $0.335 into a discrepancy the size of the
// quantity, and report a mismatch that is ours rather than the document's.
const expected = Math.round(item.quantity.value * item.unitPrice.value * 100);
const printed  = toCents(item.lineTotal.value);
if (Math.abs(expected - printed) <= 1) continue;   // 1c rounding tolerance
```

That comment records a real bug: the first version converted to cents first,
which a test caught.

### Contradictions in prose

```ts
const COUNTED = /(\d+)\s+(pallets?|cartons?|packages?|bundles?)\b/gi;
```

Collects sightings per noun; two distinct counts for the same noun is a
contradiction. Catches `KBS-10262`'s 14-vs-16 pallets. Only digits and four
nouns — an honest limitation, listed in the README.

### Duplicate pages

Fingerprints each page as its sorted `qty|price|total` triples. Pages with
identical fingerprints are flagged as possible restatements. On `KBS-DR118`
this catches all seven readable pages — which is exactly right, since they
carry identical amounts with only the lot names differing.

### The document-total decision

The most consequential rule, in
[`extract.ts`](../lib/extract/extract.ts):

- **Single page with a printed total** → verify against the sum of line totals.
  Match (within 1c): publish. Mismatch: publish **neither**, raise
  `DOCUMENT_TOTAL_MISMATCH` quoting both figures.
- **Anything else** → no total, plus `DOCUMENT_TOTAL_ABSENT` enumerating the
  concrete reasons: an unreadable page, a summary page, a returns note, a
  credit adjustment, a totals line with no figure on it.

Withholding `KBS-10270`'s $1,612.90 is deliberate. It is printed on the page,
and returning it with a warning would look more helpful — but the person is
going to put a number into a quote, and it is either right or $74.70 too high.
A warning beside a populated field gets dismissed; an empty field does not.

---

## Stage 5 — Containment

```ts
function parseOnePage(raw: RawPage, refusals: Refusal[]): ParsedPage {
  try {
    return parsePage(raw);
  } catch (err) {
    refusals.push({ code: 'PAGE_PARSE_FAILED', page: raw.page, /* ... */ });
    return emptyPage(raw);
  }
}
```

One page cannot take down the document. `KBS-DR118` proves it: page 4 is
refused, the other seven return 21 line items.

---

## Stage 6 — OCR

[`lib/extract/ocr.ts`](../lib/extract/ocr.ts) (205 lines) and
[`png.ts`](../lib/extract/png.ts) (74).

### 6a. Why it was needed

Page 4 of `KBS-DR118` looks selectable in Preview. Dumping its content stream
settles it:

```
BT /F1 12 Tf 14.4 TL ET          ← a text block that draws nothing: no Tj, no TJ
q 595.28 0 0 841.89 0 0 cm /FormXob... Do Q   ← one full-page image
```

No glyphs, no `/Annots`, no `/AcroForm`. The selection is macOS Live Text
OCR'ing the image live. Apple was doing the guessing.

### 6b. The constraint that shaped it

OCR must emit the **same `TextCell` shape** as the text-layer reader, so the
existing parser reads a scan without knowing it is one. One code path, not two.

It is also **injected, not imported**:

```ts
export type OcrFn = (raster: PageRaster) => Promise<TextCell[]>;

export interface ReadOptions {
  onPage?: (pagesDone: number, pageCount: number) => void | Promise<void>;
  ocr?: OcrFn;      // omit it and scans are refused, as before
}
```

So `lib/extract` never depends on tesseract, the default stays "refuse rather
than guess", and unit tests never load a 15 MB language model.

### 6c. Getting pixels without a native canvas

```ts
const ops = await page.getOperatorList();
// collect OPS.paintImageXObject / paintImageXObjectRepeat
const img = (await getObject(page.objs, name)) ?? (await getObject(page.commonObjs, name));
```

pdfjs decodes the image itself — no `node-canvas`, which matters for
serverless. Handles ImageKind 1 (1bpp), 2 (RGB24) and 3 (RGBA32), converting to
greyscale with the standard luma weights `(77R + 150G + 29B) >> 8`.

Every wait is bounded by a 5s timeout, because pdfjs resolves objects through a
callback that **never fires** if the object is in the other store.

Only a page that is *one whole-page image* is handled. Several images means it
is not a scan of a docket, and stitching them would be guessing at layout — so
it returns a reason instead.

Tesseract wants an encoded buffer, so [`png.ts`](../lib/extract/png.ts) writes
a minimal 8-bit greyscale PNG: IHDR, one zlib-deflated IDAT with filter byte 0
per scanline, IEND, and a hand-rolled CRC32. About 40 lines, versus a binary
dependency that does not survive deployment.

### 6d. Words into cells — the measured constant

Tesseract gives words; a table cell is a *run* of words. The threshold was
measured, not chosen. Every adjacent gap on the real page, as a multiple of the
line's median character width:

```
Item <0.64> Description <10.47> Qty <2.02> Unit <3.22> Unit <0.41> Price
1 <5.29> Framing <0.86> timber <0.78> lot <0.70> 4-1 <33.69> 10 <8.79> length
```

| | Ratio |
|---|---|
| Inside a phrase | 0.37 – 0.92 |
| Column breaks, data rows | 5.1 – 33.7 |
| Tightest genuine header break (`Qty↔Unit`) | **2.02** |

```ts
const COLUMN_GAP_RATIO = 1.4;   // clear of 0.92 below and 2.02 above
```

My first guess of 2.2 merged `Qty Unit` into one cell. The measurement lives in
a comment above the constant.

It also shows `Item↔Description` at **0.64** — tighter than words inside a
phrase, so *no* gap rule can separate them. Hence `TextCell.words`: the header
parser looks inside a merged run to recover each label's true origin.

### 6e. Coordinates

```ts
x: word.bbox.x0 * (raster.pageWidth / raster.width),
// Image y grows downward from the top; PDF y grows upward from the bottom.
y: raster.pageHeight - baseline * (raster.pageHeight / raster.height),
```

The baseline is the **median** of the line's word bottoms, shared by every cell
on that line. Per-cell baselines wobble a few points, which split one visual
row into three and lost two columns.

### 6f. Two thresholds, doing different jobs

```ts
export const MIN_WORD_CONFIDENCE  = 30;   // ocr.ts  — obvious noise only
export const TRUSTED_OCR_CONFIDENCE = 80; // rules.ts — is a figure trustworthy?
```

They are separate for a reason found the hard way. A 60 floor silently dropped
the `Qty` and `Unit` headings, which score **59 and 52** because each absorbs
the dotted rule beneath it — two columns vanished and the values under them
were mapped into the wrong fields. Dropping a word because it read poorly is
itself a way of hiding something. So the floor only removes noise, and
trustworthiness is decided later, where the answer can be *reported*:

```json
{ "value": 160, "evidence": {
    "page": 4, "sourceText": "$160.00", "source": "ocr", "confidence": 95 } }
```

Below 80 raises `LOW_OCR_CONFIDENCE` naming the exact fields. The value is
still shown — it *is* printed on the page, and hiding our best reading would be
its own dishonesty — but it never passes as a figure read from the file.

### 6g. Where OCR runs

Tesseract's worker thread does not start inside a Next.js route handler; the
call never returns. So OCR runs **only in the standalone worker**
(`OCR_ENABLED=true`, set by `npm run worker`), and is bounded to 60s per page
so a wedge becomes a refusal rather than a hang. Serverless paths refuse scans
exactly as before.

---

## The database

[`supabase/migrations/`](../supabase/migrations) — three files.

```sql
create table public.extraction_jobs (
  id uuid primary key default gen_random_uuid(),

  folder_name  text   not null,          -- one UUID folder per job
  object_key   text   not null unique,   -- folder/filename in the bucket
  file_name    text   not null,
  byte_size    bigint not null check (byte_size > 0),
  content_type text,

  status text not null default 'awaiting_upload'
    check (status in ('awaiting_upload','queued','processing','succeeded','failed')),
  page_count int,
  pages_done int not null default 0,

  result jsonb,              -- the ExtractionResult, written once on success
  failure_code    text,      -- only when we never got to look at the document
  failure_message text,      -- the sentence a person reads

  attempts int not null default 0,
  created_at timestamptz not null default now(),
  uploaded_at timestamptz, started_at timestamptz, finished_at timestamptz
);

create index on public.extraction_jobs (status, created_at)
  where status in ('queued','processing');

alter table public.extraction_jobs enable row level security;  -- no policies
```

RLS on with **no policies** denies `anon` and `authenticated` entirely; all
access is via the service role from our own server.

**The table is the queue.** Claiming is one statement:

```sql
update public.extraction_jobs
   set status = 'processing', started_at = now(), attempts = attempts + 1
 where id = (select id from public.extraction_jobs
              where status = 'queued' order by created_at
              for update skip locked limit 1)
returning *;
```

`FOR UPDATE SKIP LOCKED` locks the chosen row and makes other transactions skip
past it, so N workers never take the same job. The claim and the job state are
the same row in the same transaction — no window where a message is acked but
the state did not save.

`claim_extraction_job_by_id(job_id, stall_timeout)` is the push-delivery
variant. Vercel Queues delivers **at least once**, so the consumer must win a
claim before doing anything:

```sql
 where id = job_id
   and (status = 'queued'
        or (status = 'processing' and started_at < now() - stall_timeout))
```

A duplicate delivery gets no row and returns untouched. A redelivery *after a
crash* wins, because a stale `processing` row is exactly what a retry is for.

All three functions are `security invoker` with `execute` revoked from
`public`, `anon` and `authenticated` — Postgres grants execute to `PUBLIC` on
every new function, so without those revokes anyone with the publishable key
could drain the queue.

---

## The job flow

```
POST /api/jobs              → insert row, mint signed upload token
browser → Supabase Storage  → PUT the PDF directly (never through a function)
POST /api/jobs/{id}/uploaded → verify the object landed, status = queued, publish
Vercel Queues → /api/queues/extract → claim → download → extract → write back
GET /api/jobs/{id}          → status, progress, result or failure
```

The browser does not poll for the answer. It subscribes to a Realtime
broadcast channel named `job:{uuid}`, and the consumer publishes a small
`JobSignal` on every transition:

```ts
await admin().channel(`job:${jobId}`).httpSend('update', {
  status: 'processing', pagesDone, pageCount,
});
```

`httpSend` is a stateless REST broadcast, so a consumer that lives for a single
invocation never has to hold a socket open.

**Broadcast rather than `postgres_changes`**, because postgres changes are
filtered by RLS and `extraction_jobs` has RLS on with no policies. Opening it
for reads would hand every document's extracted contents to anyone holding the
publishable key. A channel keyed by the job's UUID is capability-based —
knowing the id is already exactly what `GET /api/jobs/{id}` requires.

**The signal never carries the result**, only the news that there is one: a
400-page `ExtractionResult` is megabytes and would exceed the broadcast payload
limit. The browser fetches the authoritative answer once it sees a terminal
status.

**A 10s backstop poll remains, and is required for correctness rather than as
a belt-and-braces extra.** Broadcast is fire-and-forget with no replay, so a
message sent before this browser finished subscribing — or while the socket was
reconnecting — is gone. Realtime alone would be *less* reliable than polling.
So the order is: subscribe, then read once to catch anything already missed,
then let broadcasts drive it, with the backstop covering the rest.

Measured on the eight-page sample: **2 HTTP requests** for the whole job
(the opening reconcile and one triggered by `succeeded`), against roughly 5 for
the old 1.5s loop, with progress arriving every ~0.35s instead of every 1.5s.

The direct upload is the point: Vercel caps serverless request bodies at
~4.5 MB, so routing a large file through a function fails before any of our own
error handling runs.

**The distinction the whole job layer protects:**

```
succeeded — we read the document. Its result may be nothing but refusals.
failed    — we never got to look at the document at all.
```

Collapsing those is how *"page 4 is a scan we cannot read"* becomes *"job
failed"*.

---

## Tests

48 across three files, run with `npm test`.

| File | Covers |
|---|---|
| `tests/refusals.test.ts` | Each refusal case in the samples, plus two payload-wide invariants |
| `tests/ocr.test.ts` | OCR provenance, confidence, word→cell grouping, the three scan-refusal variants |
| `tests/jobs.test.ts` | Claim parsing and what the browser is told |

The strongest one walks the **entire** response, takes every number, and
asserts its quoted text really is printed on the page it cites:

```ts
for (const number of tracedNumbers(result)) {
  expect(textByPage.get(number.page)!.has(number.sourceText)).toBe(true);
}
```

That enforces the rule structurally rather than field by field. Several others
assert the *absence* of tempting wrong answers — `4683` (summing DR118's seven
readable pages), `5352` (summing all eight, once OCR makes the eighth
readable), `2002.4` (the scanned total, when OCR is off), and `108` and `272`
(qty × price where no line total is printed).

---

## Known limits

Collected here; each is also in the README.

- Column detection hinges on a header containing "Item" and "Description".
- OCR proven on one document; the gap ratio and the 80% bar are measured and
  chosen respectively, not calibrated across vendors.
- A scanned page loses its heading, so the summary/returns/credit rules do not
  apply to scans.
- Prose contradictions cover four nouns, digits only.
- No resumability: a consumer dying on page 180 of 200 restarts at page 1.
- No auth; any caller can create a job and read any job by id.
