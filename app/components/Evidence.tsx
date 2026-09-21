import type { Evidence } from '@/lib/extract/types';

/**
 * A quoted piece of the document. Every number on screen can show one of
 * these, which is the whole point: the figure is checkable against the
 * original without leaving the page.
 */
export function EvidenceQuote({ evidence }: { evidence: Evidence }) {
  return (
    <div className="flex gap-2 text-xs leading-relaxed">
      <span className="shrink-0 font-medium text-slate-500">Page {evidence.page}</span>
      <span className="font-mono text-slate-700">&ldquo;{evidence.sourceText}&rdquo;</span>
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
