// Typed message contracts between the side panel, service worker, content script and page-world script.
import type { CheckpointMode, TimedItem } from './checkpoints';
import type { Rect } from './image';
import type { FrameInput } from './prompt';
import type { DataKind } from './records';
import type {
  AskKind,
  Bookmark,
  CaptionStatus,
  CheckpointResult,
  Confidence,
  Depth,
  FeynmanResult,
  HistoryEntry,
  NotationEntry,
  PracticeProblem,
  PrereqCheck,
  ProblemAttempt,
  QuizItem,
  RunResult,
  TeachBackResult,
  Transcript,
  VideoMap,
  VideoMeta,
} from './types';
import type { PlaylistData } from './youtube';

// ---------- shared state shapes ----------

export interface PlayerState {
  t: number;
  paused: boolean;
  ended: boolean;
  duration: number;
  rate: number;
  videoWidth: number;
  videoHeight: number;
  /** Edge density of the frame when paused (0..1), for confusion signals; null otherwise. */
  density?: number | null;
}

export interface VideoState {
  url: string;
  videoId: string | null;
  meta: VideoMeta | null;
  captions: CaptionStatus;
  player: PlayerState | null;
  playlist?: PlaylistData | null;
}

export type FrameResult =
  | {
      ok: true;
      captureId: string;
      dataUrl: string;
      width: number;
      height: number;
      nativeWidth: number;
      nativeHeight: number;
      t: number;
      via: 'canvas' | 'tab';
      qualityLabel: string;
      lowQuality: boolean;
    }
  | { ok: false; reason: 'blank' | 'no-video' | 'tab-capture-denied' | 'error'; message: string };

export type CropResult = { ok: true; dataUrl: string; width: number; height: number } | { ok: false; message: string };

// ---------- panel -> content script (chrome.tabs.sendMessage) ----------

export type ToContent =
  | { type: 'cs/ping' }
  | { type: 'cs/get-state' }
  | { type: 'cs/ensure-captions'; force?: boolean }
  | { type: 'cs/capture-frame' }
  | { type: 'cs/crop'; captureId: string; rect: Rect }
  | { type: 'cs/seek'; t: number; play?: boolean }
  | { type: 'cs/play' }
  | { type: 'cs/pause' }
  | { type: 'cs/arm-checkpoints'; videoId: string; mode: CheckpointMode; items: TimedItem[]; done: string[] }
  | { type: 'cs/set-rate'; rate: number }
  | { type: 'cs/engage'; frameBuffer: boolean }
  | { type: 'cs/bookmark-data' }
  | { type: 'cs/toast'; text: string }
  | { type: 'cs/command'; action: CommandAction };

export interface ContentResponses {
  'cs/ping': { ok: true; videoId: string | null };
  'cs/get-state': VideoState;
  'cs/ensure-captions': CaptionStatus;
  'cs/capture-frame': FrameResult;
  'cs/crop': CropResult;
  'cs/seek': { ok: boolean };
  'cs/play': { ok: boolean };
  'cs/pause': { ok: boolean };
  'cs/arm-checkpoints': { ok: boolean };
  'cs/set-rate': { ok: boolean; rate: number };
  'cs/engage': { ok: boolean };
  'cs/bookmark-data': { ok: true; videoId: string; t: number; caption: string; dataUrl: string | null; hash: string | null; width: number; height: number } | { ok: false; message: string };
  'cs/toast': { ok: boolean };
  'cs/command': { ok: boolean; handled: boolean };
}

// ---------- content script / panel -> service worker (chrome.runtime.sendMessage) ----------

export type ToBackground =
  | { type: 'bg/transcript-get'; videoId: string; lang: string }
  | { type: 'bg/transcript-put'; transcript: Transcript }
  | { type: 'bg/meta-put'; meta: VideoMeta }
  | { type: 'bg/capture-tab'; rect: Rect; viewportWidth: number }
  | { type: 'bg/has-key' }
  | { type: 'bg/inject'; tabId: number }
  | { type: 'bg/frame-put'; videoId: string; t: number; dataUrl: string; hash: string; width: number; height: number; kind: 'sample' | 'bookmark' | 'ask' }
  | { type: 'bg/bookmark'; tabId: number; note?: string }
  | { type: 'bg/open-panel'; action: CommandAction }
  | { type: 'bg/inject-overlay' }
  | { type: 'bg/badge' };

export interface BackgroundResponses {
  'bg/transcript-get': Transcript | null;
  'bg/transcript-put': { ok: boolean };
  'bg/meta-put': { ok: boolean };
  'bg/capture-tab': { ok: true; dataUrl: string } | { ok: false; reason: 'denied' | 'error'; message: string };
  'bg/has-key': { hasKey: boolean; hint: string };
  'bg/inject': { ok: boolean; message?: string };
  'bg/frame-put': { ok: boolean; id: string | null; duplicate?: boolean };
  'bg/bookmark': { ok: true; bookmark: Bookmark } | { ok: false; message: string };
  'bg/open-panel': { ok: boolean };
  'bg/inject-overlay': { ok: boolean };
  'bg/badge': { ok: boolean; due: number };
}

// ---------- broadcasts to the panel (chrome.runtime.sendMessage) ----------

export type CommandAction = 'ask-moment' | 'im-lost' | 'explain-screen' | 'bookmark';

export type Broadcast =
  | { type: 'evt/video'; videoId: string | null; meta: VideoMeta | null }
  | { type: 'evt/captions'; videoId: string; status: CaptionStatus }
  | { type: 'evt/player'; videoId: string; player: PlayerState }
  | { type: 'evt/checkpoint'; videoId: string; id: string; paused: boolean }
  | { type: 'evt/command'; action: CommandAction; tabId: number; at: number }
  | { type: 'evt/seek'; videoId: string; from: number; to: number; at: number }
  | { type: 'evt/data'; videoId: string | null; kinds: DataKind[] };

// ---------- long-lived port "tutor": panel <-> service worker ----------

export const TUTOR_PORT = 'tutor';

export interface AskRequest {
  type: 'ask';
  reqId: string;
  videoId: string;
  kind: AskKind;
  question: string;
  t: number;
  paused: boolean;
  frame: (FrameInput & { qualityLabel?: string }) | null;
  frameNote: string | null;
  crop: FrameInput | null;
  captionRange: [number, number] | null;
  depth?: Depth;
  parentId?: string;
  fallbackLanguage: string;
  /** Stored frames from earlier moments to attach (§13.2). */
  earlierFrameIds?: string[];
  /** Keep the sent frame in the local store so notes can show it. */
  keepFrame?: boolean;
}

export type PortRequest =
  | AskRequest
  | { type: 'map'; reqId: string; videoId: string }
  | { type: 'grade'; reqId: string; videoId: string; checkpointId: string; answer: string; confidence: Confidence | null }
  | { type: 'practice'; reqId: string; videoId: string; concept: string; sectionIndex: number | null }
  | { type: 'grade-problem'; reqId: string; problemId: string; answer: string; code: string | null; run: RunResult | null; hintsUsed: number; confidence: Confidence | null }
  | { type: 'prereq-grade'; reqId: string; videoId: string; checks: PrereqCheck[] }
  | { type: 'feynman'; reqId: string; videoId: string; text: string }
  | { type: 'cheatsheet'; reqId: string; videoId: string }
  | { type: 'notation'; reqId: string; videoId: string; t: number; frame: FrameInput }
  | { type: 'teachback'; reqId: string; videoId: string; sectionIndex: number; text: string }
  | { type: 'quiz'; reqId: string; videoId: string; upTo: number }
  | { type: 'cancel'; reqId: string }
  | { type: 'ping' };

export interface UsageReport {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export type DoneResult =
  | { kind: 'ask'; entry: HistoryEntry; alternatives: string[] }
  | { kind: 'map'; map: VideoMap }
  | { kind: 'grade'; result: CheckpointResult }
  | { kind: 'teachback'; result: TeachBackResult }
  | { kind: 'quiz'; items: QuizItem[] }
  | { kind: 'practice'; problems: PracticeProblem[] }
  | { kind: 'grade-problem'; attempt: ProblemAttempt; problem: PracticeProblem }
  | { kind: 'prereq'; checks: PrereqCheck[] }
  | { kind: 'feynman'; result: FeynmanResult }
  | { kind: 'cheatsheet'; markdown: string }
  | { kind: 'notation'; entries: NotationEntry[] };

export type ErrorCode =
  | 'no-key'
  | 'auth'
  | 'permission'
  | 'rate-limit'
  | 'overloaded'
  | 'bad-request'
  | 'too-large'
  | 'network'
  | 'refusal'
  | 'no-transcript'
  | 'no-map'
  | 'aborted'
  | 'unknown';

export interface TutorError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export type PortEvent =
  | { type: 'started'; reqId: string; model: string }
  | { type: 'thinking'; reqId: string; text: string }
  | { type: 'delta'; reqId: string; text: string }
  | { type: 'done'; reqId: string; result: DoneResult; usage: UsageReport | null; servedBy: string; truncated: boolean }
  | { type: 'error'; reqId: string; error: TutorError }
  | { type: 'pong' };

// ---------- page-world bridge (window.postMessage) ----------

export const PAGE_SOURCE = 'yt-tutor-page';
export const CONTENT_SOURCE = 'yt-tutor-content';

export type ToPage =
  | { source: typeof CONTENT_SOURCE; id: string; type: 'player-data' }
  | { source: typeof CONTENT_SOURCE; id: string; type: 'captured'; videoId: string; lang: string; isAuto: boolean }
  | { source: typeof CONTENT_SOURCE; id: string; type: 'trigger-captions'; videoId: string; lang: string; isAuto: boolean; timeoutMs: number };

export interface PlayerData {
  playerResponse: unknown;
  chapters: { start: number; title: string }[];
  playlist?: PlaylistData | null;
}

export interface CapturedTimedText {
  url: string;
  body: string;
}

export type FromPage =
  | { source: typeof PAGE_SOURCE; id: string; type: 'player-data'; data: PlayerData | null }
  | { source: typeof PAGE_SOURCE; id: string; type: 'captured'; data: CapturedTimedText | null }
  | { source: typeof PAGE_SOURCE; id: string; type: 'trigger-captions'; data: CapturedTimedText | null; error?: string }
  | { source: typeof PAGE_SOURCE; id: ''; type: 'navigated'; data: PlayerData | null };
