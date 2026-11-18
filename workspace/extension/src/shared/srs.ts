// Spaced review (§13.4): an SM-2-style scheduler, card builders, and interleaved queue order.
import { formatTime, watchUrl } from './time';
import type { CheckpointResult, Mistake, ReviewCard, VideoRecord } from './types';

export type Grade = 'again' | 'hard' | 'good' | 'easy';
export const DAY = 86_400_000;
const MIN_EASE = 1.3;

export function newCard(fields: Pick<ReviewCard, 'id' | 'videoId' | 'videoTitle' | 'concept' | 'kind' | 'front' | 'back' | 'at'> & { priority?: number }, now = Date.now()): ReviewCard {
  return { priority: 0, ...fields, ease: 2.5, interval: 0, reps: 0, lapses: 0, due: now, createdAt: now, lastReviewed: null };
}

/** SM-2 with four buttons. Intervals are in days; "again" comes back in 10 minutes. */
export function schedule(card: ReviewCard, grade: Grade, now = Date.now()): ReviewCard {
  let { ease, interval, reps, lapses } = card;
  if (grade === 'again') {
    return { ...card, ease: Math.max(MIN_EASE, ease - 0.2), interval: 0, reps: 0, lapses: lapses + 1, due: now + 10 * 60_000, lastReviewed: now };
  }
  if (grade === 'hard') ease = Math.max(MIN_EASE, ease - 0.15);
  if (grade === 'easy') ease = ease + 0.15;
  if (reps === 0) interval = grade === 'easy' ? 4 : 1;
  else if (reps === 1) interval = grade === 'hard' ? 3 : grade === 'easy' ? 8 : 6;
  else interval = grade === 'hard' ? interval * 1.2 : grade === 'easy' ? interval * ease * 1.3 : interval * ease;
  interval = Math.round(interval * 10) / 10;
  // A successful review clears "review first" priority.
  return { ...card, ease: Math.round(ease * 100) / 100, interval, reps: reps + 1, lapses, due: now + interval * DAY, lastReviewed: now, priority: 0 };
}

export function isDue(card: ReviewCard, now = Date.now()): boolean {
  return card.due <= now;
}

/**
 * Review order: high-priority cards ("sure but wrong" misconceptions) first; within each priority
 * band, cards are interleaved round-robin across videos so a session mixes subjects (§13.4).
 */
export function interleave(cards: ReviewCard[]): ReviewCard[] {
  const bands = new Map<number, ReviewCard[]>();
  for (const c of cards) bands.set(c.priority, [...(bands.get(c.priority) ?? []), c]);
  const out: ReviewCard[] = [];
  for (const p of [...bands.keys()].sort((a, b) => b - a)) {
    const byVideo = new Map<string, ReviewCard[]>();
    for (const c of bands.get(p)!.sort((a, b) => a.due - b.due || a.id.localeCompare(b.id))) byVideo.set(c.videoId, [...(byVideo.get(c.videoId) ?? []), c]);
    const queues = [...byVideo.values()].sort((a, b) => a[0].due - b[0].due);
    for (let i = 0; queues.some((q) => i < q.length); i++) for (const q of queues) if (i < q.length) out.push(q[i]);
  }
  return out;
}

/** Inserts a card or refreshes its content, keeping its schedule. `dueNow` brings it back into the queue. */
export function upsertCard(existing: ReviewCard | undefined, fresh: ReviewCard, dueNow: boolean, now = Date.now()): ReviewCard {
  if (!existing) return fresh;
  return {
    ...existing,
    front: fresh.front,
    back: fresh.back,
    at: fresh.at ?? existing.at,
    videoTitle: fresh.videoTitle || existing.videoTitle,
    priority: Math.max(existing.priority, fresh.priority),
    due: dueNow ? Math.min(existing.due, now) : existing.due,
  };
}

const link = (videoId: string, t: number | null) => (t == null ? '' : `\n\n[${formatTime(t)}](${watchUrl(videoId, t)})`);

export const conceptCardId = (videoId: string, concept: string) => `concept:${videoId}:${concept.toLowerCase()}`;
export const checkpointCardId = (videoId: string, checkpointId: string) => `checkpoint:${videoId}:${checkpointId}`;
export const mistakeCardId = (mistakeId: string) => `mistake:${mistakeId}`;

export function conceptCard(video: Pick<VideoRecord, 'videoId' | 'title' | 'map'>, concept: string, now = Date.now()): ReviewCard {
  const c = video.map?.concepts.find((x) => x.name.toLowerCase() === concept.toLowerCase());
  return newCard(
    {
      id: conceptCardId(video.videoId, concept),
      videoId: video.videoId,
      videoTitle: video.title,
      concept,
      kind: 'concept',
      front: `Explain **${concept}** in your own words, and why it matters in this lecture.`,
      back: (c?.summary || 'Rewatch where it is introduced.') + link(video.videoId, c?.definedAt ?? null),
      at: c?.definedAt ?? null,
    },
    now,
  );
}

export function checkpointCard(video: Pick<VideoRecord, 'videoId' | 'title' | 'map'>, r: CheckpointResult, now = Date.now()): ReviewCard {
  const cp = video.map?.checkpoints.find((x) => x.id === r.checkpointId);
  const sure = r.confidence === 'high' && r.verdict === 'incorrect';
  return newCard(
    {
      id: checkpointCardId(video.videoId, r.checkpointId),
      videoId: video.videoId,
      videoTitle: video.title,
      concept: r.concepts[0] ?? null,
      kind: 'checkpoint',
      front: r.question,
      back: (cp?.answer || r.correction || r.feedback) + link(video.videoId, r.at),
      at: r.at,
      priority: sure ? 2 : 0,
    },
    now,
  );
}

export function mistakeCard(m: Mistake, videoTitle: string, now = Date.now()): ReviewCard {
  const sure = m.confidence === 'high';
  return newCard(
    {
      id: mistakeCardId(m.id),
      videoId: m.videoId,
      videoTitle,
      concept: m.concepts[0] ?? null,
      kind: 'mistake',
      front: m.question,
      back: [m.misconception && `**Misconception:** ${m.misconception}`, m.correction && `**Correction:** ${m.correction}`].filter(Boolean).join('\n\n') + link(m.videoId, m.at),
      at: m.at,
      priority: sure ? 2 : 1,
    },
    now,
  );
}

/** Cards a video's state implies: shaky concepts and missed checkpoints. */
export function cardsForVideo(video: VideoRecord, now = Date.now()): ReviewCard[] {
  const out: ReviewCard[] = [];
  for (const [name, rec] of Object.entries(video.learner.concepts)) if (rec.state === 'shaky') out.push(conceptCard(video, name, now));
  for (const r of video.checkpointResults) if (r.verdict === 'partial' || r.verdict === 'incorrect') out.push(checkpointCard(video, r, now));
  return out;
}
