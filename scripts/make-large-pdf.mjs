/**
 * Generates a large mock delivery docket for testing the upload pipeline.
 *
 * Two knobs, because "large" means two unrelated things:
 *
 *   --pages N     how much EXTRACTION work the file is. Every text page is a
 *                 real Kowhai-format docket the parser can read, so N pages
 *                 means roughly 4N line items to extract.
 *
 *   --size MB     how many BYTES the file is. This is what exercises the
 *                 upload path. Bytes come from full-page scan images, which
 *                 is why real dockets are large too — and those pages have no
 *                 text layer, so the extractor correctly refuses them.
 *
 * Usage:
 *   node scripts/make-large-pdf.mjs --size 20 --pages 400 --out generated/big.pdf
 *
 * Output is written outside version control; `generated/` is gitignored.
 */

import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ args */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TARGET_BYTES = Math.round(Number(arg('size', '20')) * 1024 * 1024);
const TEXT_PAGES = Number(arg('pages', '400'));
const OUT = path.resolve(arg('out', 'generated/mock-large.pdf'));

/* ------------------------------------------------------- page furniture */

const PAGE_W = 595.28;
const PAGE_H = 841.89;

// The same column origins the real samples use, so the existing positional
// parser reads these pages without a special case.
const COL = { item: 43, desc: 71, qty: 326, unit: 377, price: 428, total: 502 };

const PRODUCTS = [
  ['10mm GIB Standard board 2400x1200', 'sheet', 24.9],
  ['13mm GIB Fyreline board 2700x1200', 'sheet', 38.5],
  ['H3.2 framing 90x45 4.8m', 'length', 18.4],
  ['H3.2 framing 140x45 4.8m', 'length', 27.6],
  ['Roof underlay roll 1.5x50m', 'roll', 210.0],
  ['Stud adhesive 400ml cartridge', 'ea', 9.8],
  ['Joist hangers 140mm galv', 'ea', 3.9],
  ['Plasterboard screws 32mm (box of 1000)', 'box', 42.0],
  ['GIB Rondo top hat batten 3.6m', 'ea', 14.2],
  ['Wet area membrane roll', 'roll', 189.0],
];

const STREETS = [
  'Tirau Street', 'Konini Place', 'Harakeke Lane', 'Matai Grove',
  'Awapuni Road', 'Ranfurly Ave', 'Beach Road', 'Kowhai Terrace',
];

const money = (n) => `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const esc = (s) => s.replace(/([\\()])/g, '\\$1');

function text(x, y, font, size, value) {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${esc(value)}) Tj ET\n`;
}

/** One realistic, internally consistent docket page. */
function textPage(pageNo, totalPages) {
  // Vary quantities per page so no two pages share a fingerprint — otherwise
  // the duplicate-page rule would quite rightly flag the whole document.
  const lineCount = 4 + (pageNo % 3);
  const lines = [];
  for (let i = 0; i < lineCount; i++) {
    const [desc, unit, price] = PRODUCTS[(pageNo * 3 + i) % PRODUCTS.length];
    const qty = 4 + ((pageNo * 7 + i * 13) % 96);
    lines.push({ n: i + 1, desc, unit, price, qty, total: Math.round(qty * price * 100) / 100 });
  }
  const pageTotal = Math.round(lines.reduce((a, l) => a + l.total, 0) * 100) / 100;

  let s = '';
  s += text(COL.item, 785, 'F2', 16, 'Kowhai Building Supplies Ltd');
  s += text(COL.item, 765, 'F1', 11, `Bulk Delivery Run 400 - Drop ${pageNo} of ${totalPages}`);
  s += text(COL.item, 746, 'F1', 10, 'Document No: KBS-BULK400');
  s += text(COL.item, 731, 'F1', 10, 'Date: 21 September 2026');
  s += text(COL.item, 717, 'F1', 10, `Delivered to: Site ${pageNo}, ${STREETS[pageNo % STREETS.length]}`);

  s += text(COL.item, 666, 'F2', 10, 'Item');
  s += text(COL.desc, 666, 'F2', 10, 'Description');
  s += text(COL.qty, 666, 'F2', 10, 'Qty');
  s += text(COL.unit, 666, 'F2', 10, 'Unit');
  s += text(COL.price, 666, 'F2', 10, 'Unit Price');
  s += text(COL.total, 666, 'F2', 10, 'Line Total');
  s += text(COL.item, 660, 'F1', 10, '-'.repeat(118));

  let y = 643;
  for (const l of lines) {
    s += text(COL.item, y, 'F1', 10, String(l.n));
    s += text(COL.desc, y, 'F1', 10, l.desc);
    s += text(COL.qty, y, 'F1', 10, String(l.qty));
    s += text(COL.unit, y, 'F1', 10, l.unit);
    s += text(COL.price, y, 'F1', 10, money(l.price));
    s += text(COL.total, y, 'F1', 10, money(l.total));
    y -= 17;
  }

  s += text(337, y - 17, 'F2', 10, 'Total:');
  s += text(COL.total, y - 17, 'F2', 10, money(pageTotal));
  s += text(COL.item, y - 45, 'F1', 9, `Page ${pageNo} of ${totalPages}`);

  return { content: Buffer.from(s, 'latin1'), lineCount, pageTotal };
}

/**
 * A page that is a scan: one grayscale image, no text layer at all.
 * This is where the bytes come from, and it is also the honest reason real
 * dockets are large. The extractor should refuse every one of these.
 */
function scanImage(bytes) {
  // Roughly A4 proportions, sized so width*height lands near the byte budget.
  const height = Math.max(64, Math.round(Math.sqrt((bytes * 2339) / 1654)));
  const width = Math.max(64, Math.round((height * 1654) / 2339));
  const data = Buffer.alloc(width * height);

  // Paper-ish background with streaks and blotches, so it reads as a bad
  // photocopy rather than television static. Uncompressed, so the byte count
  // is exactly width*height and the target size is predictable.
  for (let y = 0; y < height; y++) {
    const streak = 236 - ((y % 97) < 3 ? 40 : 0);
    for (let x = 0; x < width; x++) {
      const grit = ((x * 2654435761 + y * 40503) >>> 24) & 0x1f;
      data[y * width + x] = Math.max(0, Math.min(255, streak - grit));
    }
  }

  return { width, height, data };
}

/* ------------------------------------------------------- pdf assembly */

const objects = []; // 1-indexed on write; objects[i] is object i+1

function add(body) {
  objects.push(body);
  return objects.length;
}

function stream(dict, data) {
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

// 1 catalog, 2 pages — reserved so Kids can be filled in once pages exist.
add(Buffer.alloc(0));
add(Buffer.alloc(0));
const F1 = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'latin1'));
const F2 = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>', 'latin1'));

const pageRefs = [];
let lineItems = 0;

for (let p = 1; p <= TEXT_PAGES; p++) {
  const { content, lineCount } = textPage(p, TEXT_PAGES);
  lineItems += lineCount;
  const contentRef = add(stream('', content));
  pageRefs.push(
    add(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Resources << /Font << /F1 ${F1} 0 R /F2 ${F2} 0 R >> >> ` +
          `/Contents ${contentRef} 0 R >>`,
        'latin1',
      ),
    ),
  );
}

// Work out how many bytes are still needed, then spend them on scan pages.
const overheadSoFar = objects.reduce((n, o) => n + o.length + 24, 200);
const perScanPageOverhead = 400;
const MAX_SCAN_BYTES = 8 * 1024 * 1024; // keep individual objects manageable

let remaining = TARGET_BYTES - overheadSoFar;
let scanPages = 0;

while (remaining > perScanPageOverhead + 4096) {
  const budget = Math.min(remaining - perScanPageOverhead, MAX_SCAN_BYTES);
  const { width, height, data } = scanImage(budget);
  const imgRef = add(
    stream(
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        `/ColorSpace /DeviceGray /BitsPerComponent 8`,
      data,
    ),
  );
  const contentRef = add(
    stream('', Buffer.from(`q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im0 Do Q\n`, 'latin1')),
  );
  pageRefs.push(
    add(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Resources << /XObject << /Im0 ${imgRef} 0 R >> >> ` +
          `/Contents ${contentRef} 0 R >>`,
        'latin1',
      ),
    ),
  );
  scanPages++;
  remaining -= data.length + perScanPageOverhead;
}

objects[0] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1');
objects[1] = Buffer.from(
  `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`,
  'latin1',
);

/* ------------------------------------------------------------ write it */

const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
let offset = chunks[0].length;
const offsets = [];

objects.forEach((body, i) => {
  offsets.push(offset);
  const piece = Buffer.concat([
    Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
    body,
    Buffer.from('\nendobj\n', 'latin1'),
  ]);
  chunks.push(piece);
  offset += piece.length;
});

let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
chunks.push(Buffer.from(xref, 'latin1'));

const pdf = Buffer.concat(chunks);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, pdf);

console.log(`wrote ${OUT}`);
console.log(`  ${(pdf.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`  ${pageRefs.length} pages — ${TEXT_PAGES} readable, ${scanPages} scans with no text layer`);
console.log(`  ~${lineItems} line items to extract, ${scanPages} pages that should be refused`);
