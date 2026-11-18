// User settings, model catalogue and storage keys.
import type { CheckpointMode } from './checkpoints';

export const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Fast; the default', inPerM: 2, outPerM: 10, cacheReadPerM: 0.1 },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Stronger reasoning', inPerM: 4, outPerM: 20, cacheReadPerM: 0.2 },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', note: 'Most capable; slowest and priciest', inPerM: 8, outPerM: 40, cacheReadPerM: 0.2 },
] as const;

export type ModelId = (typeof MODELS)[number]['id'];
export type Effort = 'low' | 'medium' | 'high';

export interface Settings {
  model: ModelId;
  effort: Effort;
  /** §12.1: generate the lesson map when the panel opens on a video with captions. */
  prepareLessonAutomatically: boolean;
  checkpointMode: CheckpointMode;
  /** §12.4: for exercise-like questions, give a hint and ask for an attempt first. */
  hintsFirst: boolean;
  /** Videos up to this length get the full transcript in the cached prefix (§5). */
  fullTranscriptMinutes: number;
  /** How many earlier Q&A turns are replayed to the model. */
  historyTurns: number;
  /** §13.2: keep a rolling buffer of sampled frames (stored locally only). */
  frameBuffer: boolean;
  /** §13.2: change the playback rate per section. Off by default. */
  smartSpeed: boolean;
  /** §13.2: dictate questions with the browser's speech recognition. Off by default. */
  voiceInput: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  prepareLessonAutomatically: true,
  checkpointMode: 'gentle',
  hintsFirst: false,
  fullTranscriptMinutes: 60,
  historyTurns: 10,
  frameBuffer: true,
  smartSpeed: false,
  voiceInput: false,
};

export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const s = { ...DEFAULT_SETTINGS };
  if (MODELS.some((m) => m.id === r.model)) s.model = r.model as ModelId;
  if (r.effort === 'low' || r.effort === 'medium' || r.effort === 'high') s.effort = r.effort;
  if (typeof r.prepareLessonAutomatically === 'boolean') s.prepareLessonAutomatically = r.prepareLessonAutomatically;
  if (r.checkpointMode === 'off' || r.checkpointMode === 'gentle' || r.checkpointMode === 'active') s.checkpointMode = r.checkpointMode;
  if (typeof r.hintsFirst === 'boolean') s.hintsFirst = r.hintsFirst;
  if (typeof r.fullTranscriptMinutes === 'number' && r.fullTranscriptMinutes >= 5 && r.fullTranscriptMinutes <= 600) s.fullTranscriptMinutes = Math.round(r.fullTranscriptMinutes);
  if (typeof r.historyTurns === 'number' && r.historyTurns >= 0 && r.historyTurns <= 40) s.historyTurns = Math.round(r.historyTurns);
  for (const k of ['frameBuffer', 'smartSpeed', 'voiceInput'] as const) if (typeof r[k] === 'boolean') s[k] = r[k] as boolean;
  return s;
}

export function modelInfo(id: string) {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export const EMPTY_USAGE: UsageTotals = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

/** Estimated cost of one response at list prices (5-minute cache writes at 1.25x input). */
export function estimateCost(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const m = modelInfo(model);
  return (u.input * m.inPerM + u.cacheWrite * m.inPerM * 1.25 + u.cacheRead * m.cacheReadPerM + u.output * m.outPerM) / 1_000_000;
}

/** chrome.storage keys. Learning data lives in IndexedDB (see db.ts). */
export const KEYS = {
  apiKey: 'apiKey',
  settings: 'settings',
  profile: 'profile',
  /** storage.session */
  usage: 'usage',
  pendingCommand: 'pendingCommand',
} as const;
