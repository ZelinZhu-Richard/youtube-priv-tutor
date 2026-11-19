// Timestamp parsing and formatting. Pure functions.

/** 754 -> "12:34"; 3723 -> "1:02:03". Negative or non-finite values clamp to 0. */
export function formatTime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/**
 * Parses "12:34", "1:02:03", "0:05", "754", "754s", "12m34s", "1h2m3s".
 * Returns null for anything else, or when minutes/seconds fields are out of range.
 */
export function parseTime(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  let m = /^(\d+):([0-5]?\d):([0-5]\d)(?:\.\d+)?$/.exec(s);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = /^(\d+):([0-5]\d)(?:\.\d+)?$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+(?:\.\d+)?)s?$/.exec(s);
  if (m) return Math.floor(Number(m[1]));
  m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (m && (m[1] || m[2] || m[3])) return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return null;
}

/** A bracketed timestamp or range as the tutor writes it: [12:34], [1:02:03], [12:34–13:10], [12:34-13:10]. */
export const TIMESTAMP_RE = /\[(\d{1,2}(?::\d{2}){1,2})(?:\s*[–—-]\s*(\d{1,2}(?::\d{2}){1,2}))?\]/g;

export interface FoundTimestamp {
  index: number;
  length: number;
  start: number;
  end: number | null;
  label: string;
}

/** Finds bracketed timestamps in text. Ignores matches that are markdown links ("[12:34](...)"). */
export function findTimestamps(text: string): FoundTimestamp[] {
  const out: FoundTimestamp[] = [];
  const re = new RegExp(TIMESTAMP_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (text[m.index + m[0].length] === '(') continue;
    const start = parseTime(m[1]);
    if (start === null) continue;
    const end = m[2] ? parseTime(m[2]) : null;
    out.push({ index: m.index, length: m[0].length, start, end, label: m[0].slice(1, -1) });
  }
  return out;
}

/** A YouTube URL that opens the video at a time. */
export function watchUrl(videoId: string, t?: number): string {
  const base = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  return t !== undefined && t > 0 ? `${base}&t=${Math.floor(t)}s` : base;
}
