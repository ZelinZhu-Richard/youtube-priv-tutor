// Notation and glossary (§13.2): a running table of symbols and terms as they are introduced.
import type { NotationEntry, VideoMap } from './types';

export interface GlossaryEntry {
  kind: 'symbol' | 'term';
  label: string;
  meaning: string;
  at: number | null;
  source: 'map' | 'frame';
}

/** Symbols keep their case: X and x, or \\Delta and \\delta, are different notation. */
const normSymbol = (s: string) => s.replace(/\s+/g, '');
const normTerm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** Symbols (notation) and terms (concepts) from the lesson map, plus entries read from frames. */
export function glossaryEntries(map: VideoMap | null, extra: NotationEntry[]): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  const seen = new Set<string>();
  const add = (e: GlossaryEntry) => {
    const k = `${e.kind}:${e.kind === 'symbol' ? normSymbol(e.label) : normTerm(e.label)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };
  for (const n of [...(map?.notation ?? []), ...extra]) add({ kind: 'symbol', label: n.symbol, meaning: n.meaning, at: n.definedAt, source: n.source });
  for (const c of map?.concepts ?? []) add({ kind: 'term', label: c.name, meaning: c.summary, at: c.definedAt, source: 'map' });
  return out.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.label.localeCompare(b.label));
}

/** Entries introduced by time t (entries without a time are always shown). */
export function glossaryUpTo(entries: GlossaryEntry[], t: number): GlossaryEntry[] {
  return entries.filter((e) => e.at === null || e.at <= t + 1);
}

/** Merges notation read from a frame into the stored extras, skipping symbols already known. */
export function mergeNotation(existing: NotationEntry[], map: VideoMap | null, incoming: NotationEntry[]): NotationEntry[] {
  const known = new Set([...(map?.notation ?? []), ...existing].map((n) => normSymbol(n.symbol)));
  const out = [...existing];
  for (const n of incoming) {
    const k = normSymbol(n.symbol);
    if (!k || known.has(k)) continue;
    known.add(k);
    out.push(n);
  }
  return out;
}

export const NOTATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['symbol', 'meaning'],
        properties: { symbol: { type: 'string', description: 'LaTeX for symbols, plain text for terms' }, meaning: { type: 'string' } },
      },
    },
  },
} as const;
