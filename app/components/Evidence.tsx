import type { Evidence } from '@/lib/extract/types';

/**
 * Marks text that was read off a scan rather than out of the file.
 *
 * This is not decoration. A figure OCR produced could be wrong in a way a
 * figure read from the document cannot be, and the person deciding whether to
 * quote from it needs to see that difference without being told.
 */
export function OcrBadge({ confidence }: { confidence?: number }) {
  const unsure = (confidence ?? 100) < 80;
  return (
    <span
      className={
        'shrink-0 rounded px-1 py-px text-[10px] font-medium uppercase tracking-wide ' +
        (unsure
          ? 'bg-amber-100 text-amber-900 ring-1 ring-amber-300'
          : 'bg-slate-100 text-slate-600')
      }
      title={
        confidence !== undefined
          ? `Read from the scanned image, ${confidence}% certain`
          : 'Read from the scanned image'
      }
    >
      OCR{confidence !== undefined ? ` ${confidence}%` : ''}
    </span>
  );
}

/**
 * A quoted piece of the document. Every number on screen can show one of
 * these, which is the whole point: the figure is checkable against the
 * original without leaving the page.
 */
export function EvidenceQuote({ evidence }: { evidence: Evidence }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs leading-relaxed">
      <span className="shrink-0 font-medium text-slate-500">Page {evidence.page}</span>
      <span className="font-mono text-slate-700">&ldquo;{evidence.sourceText}&rdquo;</span>
      {evidence.source === 'ocr' && <OcrBadge confidence={evidence.confidence} />}
    </div>
  );
}

export function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <div className="mt-3 space-y-1 border-l-2 border-slate-200 pl-3">
      {evidence.map((e, i) => (
        <EvidenceQuote key={`${e.page}-${i}`} evidence={e} />
      ))}
    </div>
  );
}
