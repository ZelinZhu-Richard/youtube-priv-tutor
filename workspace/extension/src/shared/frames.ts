// Rolling frame buffer (§13.2): perceptual hashing, de-duplication, pruning, frame lookup, and
// detecting questions that refer to an earlier screen. Pure functions over plain arrays.
import { parseTime } from './time';

/** RGBA -> luminance (0..255), one value per pixel. */
export function toGray(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const j = i * 4;
    out[i] = Math.round(0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]);
  }
  return out;
}

/** Size of the image a dHash is computed from (the caller draws the frame at this size). */
export const DHASH_W = 9;
export const DHASH_H = 8;

/** 64-bit difference hash of a 9x8 grayscale image, as 16 hex characters. */
export function dHash(gray: ArrayLike<number>): string {
  let hex = '';
  for (let y = 0; y < DHASH_H; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (gray[y * DHASH_W + x] > gray[y * DHASH_W + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}

/** A static slide drifts by a few bits between samples (compression, cursor); a new slide changes many. */
export const DUPLICATE_BITS = 6;

export function isNearDuplicate(hash: string, recent: string[], threshold = DUPLICATE_BITS): boolean {
  return recent.some((h) => hamming(hash, h) <= threshold);
}

/** Placeholder stored when a frame's hash could not be computed. */
export const NO_HASH = '0000000000000000';

/** Frames whose hash can be compared; unhashed ones would look like a different slide every time. */
export function hashedFrames<F extends { hash: string }>(frames: F[]): F[] {
  return frames.filter((f) => f.hash !== NO_HASH);
}

export interface FrameLike {
  id: string;
  t: number;
  hash: string;
  kind: 'sample' | 'bookmark' | 'ask';
  createdAt: number;
}

/** Ids of sampled frames to delete so at most `max` remain; bookmark and question frames are kept. */
export function pruneFrames(frames: FrameLike[], max = 40): string[] {
  const samples = frames.filter((f) => f.kind === 'sample').sort((a, b) => b.createdAt - a.createdAt);
  return samples.slice(max).map((f) => f.id);
}

export function nearestFrame<F extends FrameLike>(frames: F[], t: number, maxDistance = Infinity): F | null {
  let best: F | null = null;
  for (const f of frames) if (!best || Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
  return best && Math.abs(best.t - t) <= maxDistance ? best : null;
}

/**
 * The n-th distinct screen before time t ("two slides ago"): walks back through stored frames,
 * counting a step each time the picture changes from the one after it.
 */
export function previousDistinct<F extends FrameLike>(frames: F[], t: number, currentHash: string | null, n = 1): F | null {
  const before = frames.filter((f) => f.t < t - 1).sort((a, b) => b.t - a.t);
  let last = currentHash;
  let steps = 0;
  for (const f of before) {
    if (last && hamming(f.hash, last) <= DUPLICATE_BITS) continue;
    steps++;
    last = f.hash;
    if (steps === n) return f;
  }
  return null;
}

/** Share of pixels with a strong horizontal or vertical gradient: high for text, code and equations. */
export function edgeDensity(gray: ArrayLike<number>, width: number, height: number, threshold = 28): number {
  if (width < 2 || height < 2) return 0;
  let strong = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i = y * width + x;
      if (Math.abs(gray[i] - gray[i + 1]) > threshold || Math.abs(gray[i] - gray[i + width]) > threshold) strong++;
    }
  }
  return strong / ((width - 1) * (height - 1));
}

export type BackwardRef = { kind: 'time'; t: number } | { kind: 'relative'; steps: number };

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, a: 1, an: 1, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4 };

/** Does the question point at an earlier screen? Returns a time or a number of screens back. */
export function detectBackwardReference(question: string): BackwardRef | null {
  const m = /(?:^|[^\d:])(\d{1,2}:\d{2}(?::\d{2})?)(?![\d:])/.exec(question);
  if (m) {
    const t = parseTime(m[1]);
    if (t !== null) return { kind: 'time', t };
  }
  const q = question.toLowerCase();
  const ago = /\b(one|two|three|four|five|a|an|\d)\s+(slides?|screens?|frames?|pages?)\s+(ago|back|before)\b/.exec(q);
  if (ago) return { kind: 'relative', steps: Math.min(5, NUMBER_WORDS[ago[1]] ?? (Number(ago[1]) || 1)) };
  const zh = /(上|前)([一两二三四]?)(页|张|个画面|个幻灯片)/.exec(question);
  if (zh) return { kind: 'relative', steps: NUMBER_WORDS[zh[2]] ?? 1 };
  if (/\b(previous|last|earlier|prior)\s+(slide|screen|frame|page|formula|equation|diagram|code|example)\b/.test(q) || /\b(earlier|before|a moment ago|back when)\b/.test(q) || /(之前|刚才|前面)/.test(question)) {
    return { kind: 'relative', steps: 1 };
  }
  return null;
}

/** Frame ids carry their kind and creation time: "fs" sample, "fb" bookmark, "fa" asked; then a time-ordered uid. */
export const FRAME_PREFIX = { sample: 'fs', bookmark: 'fb', ask: 'fa' } as const;

/** Sample ids to delete so the newest `max` samples remain (works on keys only, no blobs loaded). */
export function pruneSampleIds(ids: string[], max = 40): string[] {
  return pruneIds(ids, FRAME_PREFIX.sample, max);
}

/** Question frames kept per video; older ones are dropped (their notes keep the text). */
export const MAX_ASK_FRAMES = 60;

/** Ids with `prefix` to delete so the newest `max` remain. Ids start with a base-36 timestamp, so they sort by age. */
export function pruneIds(ids: string[], prefix: string, max: number): string[] {
  return ids
    .filter((id) => id.startsWith(prefix))
    .sort()
    .reverse()
    .slice(max);
}
