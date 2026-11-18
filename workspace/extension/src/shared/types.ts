// Core data types shared by every part of the extension.

/** One caption cue. Times are in seconds. Every caption source normalises to this shape. */
export interface Cue {
  start: number;
  duration: number;
  text: string;
}

export interface CaptionTrackInfo {
  baseUrl: string;
  languageCode: string;
  name: string;
  vssId: string;
  /** True for YouTube's automatic speech recognition track. */
  isAuto: boolean;
  /** YouTube's `variant` URL parameter, e.g. "timing-optimized" for tracks made for dubbed audio. */
  variant: string | null;
}

export interface Chapter {
  start: number;
  title: string;
}

export interface VideoMeta {
  videoId: string;
  title: string;
  channel: string;
  lengthSeconds: number;
  isLive: boolean;
  chapters: Chapter[];
  tracks: CaptionTrackInfo[];
  /** Best guess at the spoken language (BCP-47), from the audio tracks or the ASR track. */
  originalLanguage: string | null;
  /** The playlist the video was opened from, if any (§13.5). */
  playlist?: { id: string; title: string; videoIds: string[] } | null;
}

export type CaptionSource = 'player' | 'direct' | 'panel';

export interface Transcript {
  videoId: string;
  lang: string;
  trackName: string;
  isAuto: boolean;
  source: CaptionSource;
  cues: Cue[];
}

export type CaptionStatus =
  | { state: 'idle' }
  | { state: 'loading'; step: string }
  | { state: 'ready'; source: CaptionSource; lang: string; trackName: string; isAuto: boolean; count: number }
  | { state: 'none'; reason: string };

// ---- Video map (§12.1) ----

export interface MapSection {
  start: number;
  end: number;
  title: string;
  keyIdea: string;
  questions: string[];
}

export interface MapConcept {
  name: string;
  definedAt: number | null;
  dependsOn: string[];
  summary: string;
}

export type CheckpointType = 'predict' | 'next-step' | 'find-bug' | 'valid-argument' | 'explain-why';

export interface MapCheckpoint {
  id: string;
  at: number;
  sectionIndex: number;
  type: CheckpointType;
  question: string;
  answer: string;
  concepts: string[];
}

export interface NotationEntry {
  /** Symbol in LaTeX (e.g. "\\theta") or a term. */
  symbol: string;
  meaning: string;
  definedAt: number | null;
  source: 'map' | 'frame';
}

export interface PreQuestion {
  question: string;
  answer: string;
  at: number | null;
  guess?: string;
}

export interface PrereqCheck {
  prerequisite: string;
  question: string;
  answer: string;
  response?: string;
  ok?: boolean;
  gap?: string;
}

export interface VideoMap {
  videoId: string;
  createdAt: number;
  model: string;
  sections: MapSection[];
  concepts: MapConcept[];
  prerequisites: string[];
  checkpoints: MapCheckpoint[];
  /** Symbols and notation as introduced (§13.2). Absent on maps made by the first build. */
  notation?: NotationEntry[];
  /** Questions the video will answer, asked before watching (§13.1). */
  preQuestions?: PreQuestion[];
  /** Diagnostic questions on the prerequisites (§13.1). */
  prerequisiteChecks?: PrereqCheck[];
}

// ---- Learner model (§12.5) ----

export type ConceptState = 'unseen' | 'seen' | 'shaky' | 'solid';

export interface ConceptRecord {
  state: ConceptState;
  updatedAt: number;
  /** Short reasons, newest last, e.g. "I'm lost at 12:04". Capped. */
  evidence: string[];
}

export interface LearnerModel {
  concepts: Record<string, ConceptRecord>;
}

export type Verdict = 'correct' | 'partial' | 'incorrect';

export type Confidence = 'low' | 'medium' | 'high';

export interface CheckpointResult {
  checkpointId: string;
  confidence?: Confidence | null;
  misconception?: string;
  correction?: string;
  question: string;
  at: number;
  answer: string;
  verdict: Verdict | 'skipped';
  feedback: string;
  concepts: string[];
  createdAt: number;
}

export interface TeachBackResult {
  sectionIndex: number;
  text: string;
  verdict: 'solid' | 'gaps';
  feedback: string;
  concepts: string[];
  createdAt: number;
}

// ---- Conversation (§5) ----

export type AskKind =
  | 'question'
  | 'lost'
  | 'explain-screen'
  | 'extract'
  | 'walkthrough'
  | 'depth'
  | 'recap'
  | 'goal'
  | 'primer';

export type Depth = 'simpler' | 'example' | 'formal';

export interface HistoryEntry {
  id: string;
  videoId: string;
  /** Stored frame sent with this question (IndexedDB "frames"), for the notes export. */
  frameId?: string | null;
  kind: AskKind;
  /** What the learner sees as their question in the thread. */
  question: string;
  /** The durable text of the user turn replayed to the model as history (no frame, no local window). */
  userText: string;
  answer: string;
  /** Video time (s) when asked. */
  at: number;
  createdAt: number;
  model: string;
  hadFrame: boolean;
  hadCrop: boolean;
  captionRange: [number, number] | null;
  depth?: Depth;
  parentId?: string;
  /** Concepts this exchange touched (from the video map), used by the learner model. */
  concepts: string[];
}

export interface QuizItem {
  question: string;
  answer: string;
  concept: string;
  at: number | null;
}

export interface VideoProgress {
  lastT: number;
  updatedAt: number;
}

// ---- Second build (§13) ----

export interface StoredFrame {
  id: string;
  videoId: string;
  t: number;
  blob: Blob;
  /** 64-bit difference hash as 16 hex characters. */
  hash: string;
  width: number;
  height: number;
  kind: 'sample' | 'bookmark' | 'ask';
  createdAt: number;
}

export interface Bookmark {
  id: string;
  videoId: string;
  t: number;
  frameId: string | null;
  caption: string;
  note: string;
  createdAt: number;
}

export type MistakeSource = 'checkpoint' | 'problem' | 'quiz' | 'prereq' | 'feynman';

export interface Mistake {
  id: string;
  videoId: string;
  at: number | null;
  source: MistakeSource;
  question: string;
  answer: string;
  misconception: string;
  correction: string;
  confidence: Confidence | null;
  concepts: string[];
  createdAt: number;
}

export type CardKind = 'concept' | 'checkpoint' | 'mistake' | 'problem';

export interface ReviewCard {
  id: string;
  videoId: string;
  videoTitle: string;
  concept: string | null;
  kind: CardKind;
  front: string;
  back: string;
  at: number | null;
  /** Higher is reviewed first among due cards ("sure but wrong" misconceptions). */
  priority: number;
  ease: number;
  /** Days. */
  interval: number;
  reps: number;
  lapses: number;
  /** Epoch ms. */
  due: number;
  createdAt: number;
  lastReviewed: number | null;
}

export type ProblemKind = 'math' | 'code' | 'concept';

export interface CodeSpec {
  language: 'javascript' | 'python';
  starter: string;
  tests: { name: string; code: string }[];
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  error: string | null;
  tests: { name: string; passed: boolean; message: string }[];
  timedOut: boolean;
  ms: number;
}

export interface ProblemAttempt {
  answer: string;
  code: string | null;
  run: RunResult | null;
  hintsUsed: number;
  confidence: Confidence | null;
  verdict: Verdict;
  feedback: string;
  misconception: string;
  createdAt: number;
}

export interface PracticeProblem {
  id: string;
  videoId: string;
  concept: string;
  setId: string;
  /** 1: full worked example, 2: last steps blank, 3: bare problem (worked-example fading). */
  level: 1 | 2 | 3;
  kind: ProblemKind;
  statement: string;
  steps: string[];
  answer: string;
  /** Hint ladder: nudge, which idea to use, first step (the full solution is steps + answer). */
  hints: string[];
  code: CodeSpec | null;
  attempts: ProblemAttempt[];
  createdAt: number;
}

export interface LearnerProfile {
  background: string;
  goals: string;
  style: string;
}

export interface PlaylistInfo {
  id: string;
  title: string;
  videoIds: string[];
}

export interface FeynmanResult {
  text: string;
  verdict: 'solid' | 'gaps';
  feedback: string;
  missing: string[];
  createdAt: number;
}

/** Everything small stored per video (IndexedDB "videos"). Growing collections have their own stores. */
export interface VideoRecord {
  videoId: string;
  title: string;
  channel: string;
  lengthSeconds: number;
  chapters: Chapter[];
  playlist: { id: string; title: string; index: number } | null;
  createdAt: number;
  updatedAt: number;
  lastT: number;
  timeSpentSec: number;
  map: VideoMap | null;
  learner: LearnerModel;
  known: number[];
  quiz: QuizItem[];
  checkpointResults: CheckpointResult[];
  teachBacks: TeachBackResult[];
  preQuestions: PreQuestion[];
  prereqChecks: PrereqCheck[];
  feynman: FeynmanResult | null;
  cheatSheet: { markdown: string; createdAt: number } | null;
  glossaryExtra: NotationEntry[];
}
