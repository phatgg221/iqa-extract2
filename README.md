# Document extraction

Takes a PDF delivery docket or packing list and returns the line items it could
read, each carrying the page and the exact text it came from, plus a separate
list of everything it declined to extract and why.

The rule the whole thing is built around: **no number is published unless it can
be pointed at on the page.** Refusing is a result. Guessing is not.

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # 40 tests, mostly about refusals
```

Six sample documents are bundled and can be run from the page itself without
finding a file first.

---

## What it does with the samples

| Document | Result |
|---|---|
| `KBS-10234` | Clean. 5 line items, total $2,630.00, nothing refused. |
| `KBS-10241` | Scanned image, no text layer. Refused outright by default; with OCR enabled it is read from the pixels and every figure is marked `OCR` with its confidence. |
| `KBS-10255` | 4 line items with every line total `null` — the document has no Line Total column, so they are left blank rather than multiplied out. The weight column is flagged because `480g total` covers a whole line while `25kg` covers one bag. |
| `KBS-10262` | 3 line items, total $5,122.40 published. Separately flags that the header says 14 pallets and the driver's note says 16. |
| `KBS-10270` | 4 line items extracted. The printed total is $1,612.90, the lines add to $1,538.20; no total is reported and both figures are shown. |
| `KBS-DR118` | 8 pages. Page 4 is a scan: refused by default (21 line items), read by OCR when enabled (24). No document total either way, for the stated reasons. |

`KBS-DR118` is the one worth opening. Summing its readable pages gives
$4,683.00, which is wrong at least three ways over — page 5 is a summary that
restates earlier pages, pages 6 and 7 are a returns note and a credit
adjustment whose sign is never stated, and page 4 cannot be read at all. The
service reports no total and says all four things.

## How it works

```
app/api/extract/route.ts   HTTP boundary
lib/extract/pdf.ts         PDF -> positioned text cells (the only pdfjs-aware file)
lib/extract/ocr.ts         scanned page -> the same cells, tagged as OCR
lib/extract/png.ts         raw pixels -> PNG, so OCR needs no native canvas
lib/extract/table.ts       cells -> columns and rows, per page
lib/extract/rules.ts       the refusal rules
lib/extract/extract.ts     orchestration, containment, the document-total decision
app/components/            upload, results, refusals
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

The result header has **Copy JSON** and **Download**, which hand back the API
response exactly as it was returned — refusals included — so what is on screen
can be checked against what was actually sent.

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
- **Only one vendor's documents were ever tested.** Everything above follows
  from that. I have not seen this code meet a document it was not written
  against.

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
5. **Real error handling at the boundary** as described above, plus a size/page
   ceiling with streaming progress, since a 200-page set would currently block a
   request for a long time.

---

## Notes

- `samples/` holds the fixtures the tests read; `public/samples/` holds the same
  files so the page can offer them as one-click examples.
- Tests: `npm test`. The ones that matter are in `tests/refusals.test.ts` —
  each pins a case where the correct answer is "we are not going to tell you
  that", plus the two invariants that every number and every refusal quotes
  text really printed on the page it cites.
- Built with Claude Code. The design decisions above are mine and I can walk
  through any of them; the traceability invariant and the double-rounding fix in
  `lineArithmeticRefusals` both came out of writing the tests rather than the
  other way round.
