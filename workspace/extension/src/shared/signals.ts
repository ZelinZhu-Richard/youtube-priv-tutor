// Confusion signals and smart speed (§13.2). Pure functions.
import type { MapSection, VideoMap } from './types';

export interface SeekEvent {
  from: number;
  to: number;
  /** Wall-clock ms. */
  at: number;
}

/**
 * Two backward seeks over the same stretch within a few minutes ("rewound it twice") suggest
 * confusion: either the rewound ranges overlap by 3 s or more, or the second rewind starts while
 * the learner is re-watching what the first one replayed. Double-tapping the back key (two seeks
 * under 2 s apart with no watching in between) counts as one rewind. Returns the stretch, or null.
 */
export function detectRewindConfusion(seeks: SeekEvent[], now: number, windowMs = 4 * 60_000): { from: number; to: number } | null {
  const rewinds = seeks.filter((s) => now - s.at <= windowMs && s.to < s.from - 2 && s.from - s.to <= 180).sort((x, y) => x.at - y.at);
  for (let i = rewinds.length - 1; i > 0; i--) {
    for (let j = i - 1; j >= 0; j--) {
      const later = rewinds[i];
      const earlier = rewinds[j];
      const watchedBetween = later.from - earlier.to >= 1.5 && later.at - earlier.at >= 2000;
      if (!watchedBetween) continue;
      const overlap = Math.min(later.from, earlier.from) - Math.max(later.to, earlier.to);
      const againWhileRewatching = later.from >= earlier.to - 1 && later.from <= earlier.from + 5;
      if (overlap >= 3 || againWhileRewatching) return { from: Math.min(later.to, earlier.to), to: Math.max(later.from, earlier.from) };
    }
  }
  return null;
}

/** A long pause on a dense frame (an equation, a slab of code) suggests the learner is stuck. */
export function pauseConfusion(pausedForSec: number, density: number | null, minPauseSec = 25, minDensity = 0.06): boolean {
  return pausedForSec >= minPauseSec && density !== null && density >= minDensity;
}

/** New concepts and symbols per minute in a section, from the lesson map. */
export function sectionDensity(map: VideoMap, index: number): number {
  const s: MapSection | undefined = map.sections[index];
  if (!s || s.end <= s.start) return 0;
  const inside = (t: number | null) => t !== null && t >= s.start && t < s.end;
  const n = map.concepts.filter((c) => inside(c.definedAt)).length + (map.notation ?? []).filter((x) => inside(x.definedAt)).length;
  return n / ((s.end - s.start) / 60);
}

export interface RateSuggestion {
  rate: number;
  reason: 'known' | 'shaky' | 'dense' | 'normal';
}

/** Suggested playback rate for a section: slower when shaky or dense, faster when known. */
export function suggestRate(opts: { known: boolean; shaky: boolean; density: number; base: number }): RateSuggestion {
  const base = opts.base > 0 ? opts.base : 1;
  const round = (r: number) => Math.round(r * 4) / 4;
  if (opts.known) return { rate: Math.min(2, round(Math.max(base * 1.25, 1.5))), reason: 'known' };
  if (opts.shaky) return { rate: Math.max(0.75, round(base * 0.85)), reason: 'shaky' };
  if (opts.density >= 1.5) return { rate: Math.max(0.75, round(base * 0.85)), reason: 'dense' };
  return { rate: base, reason: 'normal' };
}
