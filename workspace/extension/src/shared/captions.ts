// Caption parsing and normalisation. Pure functions, no DOM.
// Every parser returns Cue[] in seconds; normalizeCues() makes them tidy and non-overlapping;
// mergeIntoChunks() turns short or word-level cues into sentence-like 10–20 s chunks for prompts.
import type { Cue } from './types';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  const once = (x: string) =>
    x.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    });
  const first = once(s);
  // Legacy XML tracks are sometimes double-encoded ("&amp;#39;").
  return /&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/.test(first) ? once(first) : first;
}

export function collapseWhitespace(s: string): string {
  return s.replace(/[\s​]+/g, ' ').trim();
}

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯＀-￯　-〿]/;

/** Joins two caption fragments with a space, except between CJK characters. */
export function smartJoin(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const last = a[a.length - 1];
  const first = b[0];
  if (CJK.test(last) && CJK.test(first)) return a + b;
  return `${a} ${b}`;
}

// ---------- json3 ----------

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
  aAppend?: number;
}

/** Parses YouTube's json3 timedtext format (manual and ASR). */
export function parseJson3(input: string | { events?: Json3Event[] }): Cue[] {
  const data = typeof input === 'string' ? (JSON.parse(input) as { events?: Json3Event[] }) : input;
  const cues: Cue[] = [];
  for (const ev of data.events ?? []) {
    if (!ev.segs || ev.tStartMs === undefined) continue;
    const text = collapseWhitespace(decodeEntities(ev.segs.map((s) => s.utf8 ?? '').join('')));
    if (!text) continue; // window definitions and "\n" append events
    cues.push({ start: ev.tStartMs / 1000, duration: (ev.dDurationMs ?? 0) / 1000, text });
  }
  return cues;
}

// ---------- XML (srv1 / srv2 / srv3) ----------

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = m[2];
  return out;
}

/**
 * Parses YouTube XML timedtext:
 *  - srv1: <transcript><text start="1.2" dur="3.4">…</text>
 *  - srv2: <timedtext><text t="1200" d="3400">…</text>
 *  - srv3: <timedtext format="3"><body><p t="1200" d="3400"><s>…</s></p>
 */
export function parseXmlTimedText(xml: string): Cue[] {
  const cues: Cue[] = [];
  const re = /<(p|text)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const a = attrs(m[2]);
    let start: number;
    let duration: number;
    if (a.start !== undefined) {
      start = Number(a.start);
      duration = Number(a.dur ?? 0);
    } else if (a.t !== undefined) {
      start = Number(a.t) / 1000;
      duration = Number(a.d ?? 0) / 1000;
    } else continue;
    if (!Number.isFinite(start)) continue;
    const inner = m[3].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
    const text = collapseWhitespace(decodeEntities(inner));
    if (!text) continue;
    cues.push({ start, duration: Number.isFinite(duration) ? duration : 0, text });
  }
  return cues;
}

// ---------- WebVTT ----------

function vttTime(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = vtt.replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, b] = lines[idx].split('-->');
    const start = vttTime(a);
    const end = vttTime(b.trim().split(/\s+/)[0]);
    if (start === null || end === null) continue;
    const body = lines.slice(idx + 1).map((l) => l.replace(/<[^>]+>/g, '')).join('\n');
    const text = collapseWhitespace(decodeEntities(body));
    if (text) cues.push({ start, duration: Math.max(0, end - start), text });
  }
  return removeRollingOverlap(cues);
}

export type TimedTextFormat = 'json3' | 'xml' | 'vtt' | 'unknown';

export function detectFormat(body: string): TimedTextFormat {
  const s = body.trimStart();
  if (s.startsWith('{')) return 'json3';
  if (s.startsWith('WEBVTT')) return 'vtt';
  if (s.startsWith('<')) return 'xml';
  return 'unknown';
}

/** Parses any timedtext body YouTube serves. Returns [] for empty or unrecognised bodies. */
export function parseTimedText(body: string): Cue[] {
  if (!body || !body.trim()) return [];
  try {
    switch (detectFormat(body)) {
      case 'json3':
        return parseJson3(body);
      case 'vtt':
        return parseVtt(body);
      case 'xml':
        return parseXmlTimedText(body);
      default:
        return [];
    }
  } catch {
    return [];
  }
}

// ---------- normalisation ----------

function words(s: string): string[] {
  return s.split(' ').filter(Boolean);
}

/**
 * Removes the "rolling" repetition of auto-caption formats where each cue repeats the tail of the
 * previous one. Only strips overlaps of at least 3 words (or a whole cue), so ordinary repetition
 * in manual captions ("no, no") survives.
 */
export function removeRollingOverlap(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ ...cue });
      continue;
    }
    // A repeated single word or pair ("no", "thank you") is speech, not a rolling duplicate.
    if (prev.text === cue.text || (words(cue.text).length >= 3 && prev.text.endsWith(cue.text))) {
      // Whole cue already shown; extend the previous cue instead of duplicating it.
      prev.duration = Math.max(prev.duration, cue.start + cue.duration - prev.start);
      continue;
    }
    const pw = words(prev.text);
    const cw = words(cue.text);
    let overlap = 0;
    for (let k = Math.min(pw.length, cw.length); k >= 3; k--) {
      if (pw.slice(pw.length - k).join(' ') === cw.slice(0, k).join(' ')) {
        overlap = k;
        break;
      }
    }
    const text = overlap ? cw.slice(overlap).join(' ') : cue.text;
    if (text) out.push({ ...cue, text });
  }
  return out;
}

/**
 * Sorts, trims, de-duplicates and de-overlaps cues:
 *  - drops empty cues and exact consecutive duplicates;
 *  - clips each cue so it ends where the next begins (auto-caption windows overlap);
 *  - gives zero-length cues a duration up to the next cue (or 2 s at the end).
 */
export function normalizeCues(cues: Cue[]): Cue[] {
  const sorted = cues
    .map((c) => ({ start: Math.max(0, c.start), duration: Math.max(0, c.duration), text: collapseWhitespace(c.text) }))
    .filter((c) => c.text && Number.isFinite(c.start))
    .sort((a, b) => a.start - b.start);
  const out: Cue[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.text === c.text && c.start - prev.start < Math.max(prev.duration, 1) + 0.5) {
      prev.duration = Math.max(prev.duration, c.start + c.duration - prev.start);
      continue;
    }
    out.push(c);
  }
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    const c = out[i];
    if (next) {
      const gap = next.start - c.start;
      if (c.duration <= 0 || c.duration > gap) c.duration = Math.max(0, gap);
    } else if (c.duration <= 0) {
      c.duration = 2;
    }
    c.start = round3(c.start);
    c.duration = round3(c.duration);
  }
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface ChunkOptions {
  /** A chunk may end once it is at least this long (s). */
  minSec?: number;
  /** A chunk never grows past this length (s) unless a single cue is longer. */
  maxSec?: number;
}

const SENTENCE_END = /[.!?。！？…]["'”’)\]]?$/;

/**
 * Merges cues into sentence-like chunks of about 10–20 s, keeping each chunk's first start time.
 * Breaks at sentence ends or pauses once a chunk is long enough, always at maxSec, and at long silences.
 */
export function mergeIntoChunks(cues: Cue[], opts: ChunkOptions = {}): Cue[] {
  const minSec = opts.minSec ?? 10;
  const maxSec = opts.maxSec ?? 20;
  const chunks: Cue[] = [];
  let cur: { start: number; end: number; text: string } | null = null;
  const flush = () => {
    if (cur) chunks.push({ start: cur.start, duration: round3(cur.end - cur.start), text: cur.text });
    cur = null;
  };
  for (const cue of cues) {
    const end = cue.start + cue.duration;
    if (!cur) {
      cur = { start: cue.start, end, text: cue.text };
      continue;
    }
    const c: { start: number; end: number; text: string } = cur;
    const len = c.end - c.start;
    const gap = cue.start - c.end;
    const wouldBe = end - c.start;
    const atSentenceEnd = SENTENCE_END.test(c.text);
    if (gap >= 4 || wouldBe > maxSec || (atSentenceEnd && len >= minSec * 0.7) || (len >= minSec && gap >= 1.2)) {
      flush();
      cur = { start: cue.start, end, text: cue.text };
    } else {
      c.text = smartJoin(c.text, cue.text);
      c.end = Math.max(c.end, end);
    }
  }
  flush();
  return chunks;
}
