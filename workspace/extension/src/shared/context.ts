// Context-window selection and transcript rendering for prompts. Pure functions.
import { formatTime } from './time';
import type { Chapter, Cue, MapConcept, MapSection, VideoMap } from './types';

export const LOCAL_BEFORE_SEC = 90;
export const LOCAL_AFTER_SEC = 15;

/** The caption range the tutor sees by default for a moment t: ~90 s before to ~15 s after (§5). */
export function defaultCaptionRange(t: number, duration = Infinity, before = LOCAL_BEFORE_SEC, after = LOCAL_AFTER_SEC): [number, number] {
  return [Math.max(0, t - before), Math.min(duration > 0 ? duration : Infinity, t + after)];
}

/** Cues that overlap [from, to]. */
export function selectWindow(cues: Cue[], from: number, to: number): Cue[] {
  return cues.filter((c) => c.start <= to && c.start + Math.max(c.duration, 0.001) >= from);
}

/** "[12:34] text" lines. */
export function renderCues(cues: Cue[]): string {
  return cues.map((c) => `[${formatTime(c.start)}] ${c.text}`).join('\n');
}

const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿가-힯]/g;

/** Rough token estimate: ~4 chars per token for Latin text, ~1 token per CJK character. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(CJK_CHAR) ?? []).length;
  return Math.ceil((text.length - cjk) / 4 + cjk);
}

export type TranscriptMode = 'full' | 'summary';

/**
 * Full transcript in the cached prefix for videos up to roughly an hour (configurable); beyond
 * that, a chapter-level summary (the video map) plus the local window (§5).
 */
export function chooseTranscriptMode(durationSec: number, transcriptTokens: number, fullUpToMinutes: number): TranscriptMode {
  // English speech runs about 4 tokens/s; Mandarin about 6 at one token per character. Allow 8.
  const maxTokens = Math.max(20_000, fullUpToMinutes * 60 * 8);
  return durationSec <= fullUpToMinutes * 60 && transcriptTokens <= maxTokens ? 'full' : 'summary';
}

export function currentChapter(chapters: Chapter[], t: number): Chapter | null {
  let found: Chapter | null = null;
  for (const c of chapters) {
    if (c.start <= t) found = c;
    else break;
  }
  return found;
}

export function currentSectionIndex(sections: MapSection[], t: number): number {
  let idx = -1;
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].start <= t) idx = i;
    else break;
  }
  return idx;
}

/**
 * Concepts relevant at time t: those first defined in the local window, else those of the current
 * section (defined inside its range), else the most recently defined concept.
 */
export function conceptsNear(map: VideoMap | null, t: number, before = LOCAL_BEFORE_SEC, after = LOCAL_AFTER_SEC): string[] {
  if (!map) return [];
  const withTime = map.concepts.filter((c): c is MapConcept & { definedAt: number } => c.definedAt !== null);
  const inWindow = withTime.filter((c) => c.definedAt >= t - before && c.definedAt <= t + after).map((c) => c.name);
  if (inWindow.length) return inWindow;
  const si = currentSectionIndex(map.sections, t);
  if (si >= 0) {
    const s = map.sections[si];
    const inSection = withTime.filter((c) => c.definedAt >= s.start && c.definedAt < s.end).map((c) => c.name);
    if (inSection.length) return inSection;
  }
  const earlier = withTime.filter((c) => c.definedAt <= t).sort((a, b) => b.definedAt - a.definedAt);
  return earlier.length ? [earlier[0].name] : [];
}
