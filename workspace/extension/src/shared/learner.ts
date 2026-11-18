// Per-video learner model (§12.5): each concept is unseen, seen, shaky or solid. Pure functions.
import type { ConceptState, LearnerModel, VideoMap } from './types';

export type LearnerEvent =
  | { type: 'watched'; t: number }
  | { type: 'asked'; concepts: string[]; note?: string }
  | { type: 'lost'; concepts: string[]; note?: string }
  | { type: 'simpler'; concepts: string[]; note?: string }
  | { type: 'checkpoint'; verdict: 'correct' | 'partial' | 'incorrect' | 'skipped'; concepts: string[]; note?: string }
  | { type: 'teachback'; verdict: 'solid' | 'gaps'; concepts: string[]; note?: string }
  | { type: 'quiz'; correct: boolean; concepts: string[]; note?: string };

export const EMPTY_LEARNER: LearnerModel = { concepts: {} };
const MAX_EVIDENCE = 5;

/** Maps a name to the map's canonical spelling (case-insensitive), or keeps it if unknown. */
export function canonicalConcept(name: string, map: VideoMap | null): string {
  const n = name.trim();
  if (!map) return n;
  const hit = map.concepts.find((c) => c.name.toLowerCase() === n.toLowerCase());
  return hit ? hit.name : n;
}

/** The state a concept moves to for an event, or null for "no change". */
function target(event: LearnerEvent, current: ConceptState): ConceptState | null {
  switch (event.type) {
    case 'watched':
    case 'asked':
      return current === 'unseen' ? 'seen' : null;
    case 'lost':
    case 'simpler':
      return 'shaky';
    case 'checkpoint':
      if (event.verdict === 'correct') return 'solid';
      if (event.verdict === 'skipped') return null;
      return 'shaky';
    case 'teachback':
      return event.verdict === 'solid' ? 'solid' : 'shaky';
    case 'quiz':
      return event.correct ? 'solid' : 'shaky';
  }
}

/** Applies one event and returns a new model (the input is not mutated). */
export function applyLearnerEvent(model: LearnerModel, event: LearnerEvent, map: VideoMap | null, now = Date.now()): LearnerModel {
  const names =
    event.type === 'watched'
      ? (map?.concepts ?? []).filter((c) => c.definedAt !== null && c.definedAt <= event.t).map((c) => c.name)
      : event.concepts.map((c) => canonicalConcept(c, map)).filter(Boolean);
  if (!names.length) return model;
  const concepts = { ...model.concepts };
  let changed = false;
  for (const name of new Set(names)) {
    const current = concepts[name]?.state ?? 'unseen';
    const next = target(event, current);
    if (!next || next === current) continue;
    const note = event.type === 'watched' ? 'watched' : event.note ?? event.type;
    const evidence = [...(concepts[name]?.evidence ?? []), note].slice(-MAX_EVIDENCE);
    concepts[name] = { state: next, updatedAt: now, evidence };
    changed = true;
  }
  return changed ? { concepts } : model;
}

export function conceptsInState(model: LearnerModel, state: ConceptState): string[] {
  return Object.entries(model.concepts)
    .filter(([, r]) => r.state === state)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .map(([name]) => name);
}

/** Short text for the tutor: what this learner has shown they know and where they struggle. */
export function learnerDigest(model: LearnerModel): string {
  const solid = conceptsInState(model, 'solid').slice(0, 20);
  const shaky = conceptsInState(model, 'shaky').slice(0, 20);
  if (!solid.length && !shaky.length) return '';
  const lines: string[] = [];
  if (shaky.length) lines.push(`Shaky (revisit gently, check understanding): ${shaky.join('; ')}`);
  if (solid.length) lines.push(`Solid (do not re-explain at length): ${solid.join('; ')}`);
  return lines.join('\n');
}
