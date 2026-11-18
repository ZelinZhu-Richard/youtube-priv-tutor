// Checkpoint timing (§12.4) and skip-known sections (§12.6). Pure functions.
import type { MapSection } from './types';

export type CheckpointMode = 'off' | 'gentle' | 'active';

export interface TimedItem {
  id: string;
  at: number;
}

/**
 * Checkpoints crossed by normal playback between two time samples. A jump larger than maxJump
 * seconds (a seek) or backwards crosses nothing, so seeking past a checkpoint never triggers it.
 */
export function crossedCheckpoints(prevT: number, curT: number, items: TimedItem[], done: ReadonlySet<string>, maxJump = 3): string[] {
  if (!(curT > prevT) || curT - prevT > maxJump) return [];
  return items.filter((cp) => !done.has(cp.id) && cp.at > prevT && cp.at <= curT).map((cp) => cp.id);
}

/**
 * If t is inside a section the learner marked as known, returns where to jump: the end of the run
 * of consecutive known sections. Null otherwise.
 */
export function skipTarget(sections: MapSection[], known: ReadonlySet<number>, t: number): { from: number; to: number } | null {
  const idx = sections.findIndex((s) => t >= s.start && t < s.end);
  if (idx < 0 || !known.has(idx)) return null;
  let last = idx;
  while (known.has(last + 1) && last + 1 < sections.length) last++;
  return { from: idx, to: sections[last].end };
}
