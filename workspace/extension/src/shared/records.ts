// Writes that keep learning data consistent across stores: learner model, results, mistakes,
// review cards. Used by the side panel, the library page and the service worker.
import * as db from './db';
import { applyLearnerEvent, type LearnerEvent } from './learner';
import { isSureButWrong } from './practice';
import { broadcast, uid } from './rpc';
import { checkpointCard, conceptCard, conceptCardId, mistakeCard, schedule, upsertCard, type Grade } from './srs';
import type { Bookmark, CheckpointResult, FeynmanResult, Mistake, PracticeProblem, ProblemAttempt, ReviewCard, TeachBackResult, VideoRecord } from './types';

export type DataKind = 'video' | 'history' | 'cards' | 'bookmarks' | 'mistakes' | 'problems' | 'frames';

/** Tells other extension views (and the worker's badge) that stored data changed. */
export function notifyChanged(videoId: string | null, kinds: DataKind[]) {
  broadcast({ type: 'evt/data', videoId, kinds });
}

async function upsertCards(cards: ReviewCard[], dueNow: boolean) {
  for (const c of cards) await db.update('cards', c.id, (cur) => upsertCard(cur, c, dueNow));
}

/** Applies a learner event; concepts that become shaky get (or are brought back as) review cards. */
export async function learn(videoId: string, ev: LearnerEvent): Promise<VideoRecord> {
  let became: string[] = [];
  const v = await db.updateVideo(videoId, (cur) => {
    const next = applyLearnerEvent(cur.learner, ev, cur.map);
    became = Object.entries(next.concepts)
      .filter(([n, r]) => r.state === 'shaky' && cur.learner.concepts[n]?.state !== 'shaky')
      .map(([n]) => n);
    return next === cur.learner ? cur : { learner: next };
  });
  if (became.length) {
    await upsertCards(became.map((n) => conceptCard(v, n)), true);
    notifyChanged(videoId, ['video', 'cards']);
  } else notifyChanged(videoId, ['video']);
  return v;
}

/** Logs a mistake; `card: false` when the item already has its own review card (missed checkpoints). */
export async function addMistake(m: Omit<Mistake, 'id' | 'createdAt'>, videoTitle: string, opts: { card?: boolean } = {}): Promise<Mistake> {
  const full: Mistake = { ...m, id: uid('mk'), createdAt: Date.now() };
  await db.put('mistakes', full);
  if (opts.card !== false) await upsertCards([mistakeCard(full, videoTitle)], true);
  notifyChanged(m.videoId, ['mistakes', 'cards']);
  return full;
}

export async function saveCheckpointResult(videoId: string, r: CheckpointResult): Promise<VideoRecord> {
  let v = await db.updateVideo(videoId, (cur) => ({ checkpointResults: [...cur.checkpointResults.filter((x) => x.checkpointId !== r.checkpointId), r] }));
  if (r.verdict !== 'skipped') {
    v = await learn(videoId, { type: 'checkpoint', verdict: r.verdict, concepts: r.concepts, note: `checkpoint${isSureButWrong(r.confidence, r.verdict) ? ' (was sure)' : ''}` });
  }
  if (r.verdict === 'partial' || r.verdict === 'incorrect') {
    await upsertCards([checkpointCard(v, r)], true);
    await addMistake({ videoId, at: r.at, source: 'checkpoint', question: r.question, answer: r.answer, misconception: r.misconception ?? '', correction: r.correction ?? '', confidence: r.confidence ?? null, concepts: r.concepts }, v.title, { card: false });
  }
  notifyChanged(videoId, ['video', 'cards']);
  return v;
}

export async function saveTeachBack(videoId: string, r: TeachBackResult): Promise<VideoRecord> {
  await db.updateVideo(videoId, (cur) => ({ teachBacks: [...cur.teachBacks, r] }));
  return learn(videoId, { type: 'teachback', verdict: r.verdict, concepts: r.concepts, note: 'explained it back' });
}

export async function saveFeynman(videoId: string, r: FeynmanResult): Promise<VideoRecord> {
  const v = await db.updateVideo(videoId, () => ({ feynman: r }));
  notifyChanged(videoId, ['video']);
  return v;
}

export async function saveProblem(p: PracticeProblem): Promise<void> {
  await db.put('problems', p);
  notifyChanged(p.videoId, ['problems']);
}

/** Records an attempt; wrong or partial attempts go to the mistake log and the review queue. */
export async function recordAttempt(problem: PracticeProblem, attempt: ProblemAttempt): Promise<PracticeProblem> {
  const next = { ...problem, attempts: [...problem.attempts, attempt] };
  await db.put('problems', next);
  const v = await learn(problem.videoId, { type: 'checkpoint', verdict: attempt.verdict, concepts: [problem.concept], note: `practice level ${problem.level}` });
  if (attempt.verdict !== 'correct') {
    await addMistake(
      {
        videoId: problem.videoId,
        at: v.map?.concepts.find((c) => c.name.toLowerCase() === problem.concept.toLowerCase())?.definedAt ?? null,
        source: 'problem',
        question: problem.statement,
        answer: attempt.code ? `${attempt.answer}\n\n${attempt.code}`.trim() : attempt.answer,
        misconception: attempt.misconception,
        correction: problem.answer,
        confidence: attempt.confidence,
        concepts: [problem.concept],
      },
      v.title,
    );
  }
  notifyChanged(problem.videoId, ['problems']);
  return next;
}

export async function reviewCard(card: ReviewCard, grade: Grade): Promise<ReviewCard> {
  const next = schedule(card, grade);
  await db.put('cards', next);
  if (card.concept && (grade === 'good' || grade === 'easy') && card.kind === 'concept') {
    // A concept reviewed well twice in a row counts as solid again.
    if (next.reps >= 2) await learn(card.videoId, { type: 'quiz', correct: true, concepts: [card.concept], note: 'spaced review' });
  }
  notifyChanged(card.videoId, ['cards']);
  return next;
}

export async function addBookmark(b: Omit<Bookmark, 'id' | 'createdAt'>): Promise<Bookmark> {
  const full: Bookmark = { ...b, id: uid('bm'), createdAt: Date.now() };
  await db.put('bookmarks', full);
  notifyChanged(b.videoId, ['bookmarks']);
  return full;
}

export async function updateBookmark(b: Bookmark): Promise<void> {
  await db.put('bookmarks', b);
  notifyChanged(b.videoId, ['bookmarks']);
}

export async function deleteBookmark(b: Bookmark): Promise<void> {
  await db.del('bookmarks', b.id);
  notifyChanged(b.videoId, ['bookmarks']);
}

export async function removeConceptCard(videoId: string, concept: string): Promise<void> {
  await db.del('cards', conceptCardId(videoId, concept));
}
