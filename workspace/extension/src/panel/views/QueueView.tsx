// Spaced review queue (§13.4): due cards across all videos, interleaved, "sure but wrong" first.
import { useEffect, useState } from 'preact/hooks';
import * as db from '../../shared/db';
import * as records from '../../shared/records';
import { DAY, interleave, schedule, type Grade } from '../../shared/srs';
import { formatTime, watchUrl } from '../../shared/time';
import type { ReviewCard } from '../../shared/types';
import { Prose } from '../ui';

function interval(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < DAY) return `${Math.round(ms / 3_600_000)} h`;
  const d = ms / DAY;
  return d < 60 ? `${Math.round(d)} d` : `${Math.round(d / 30)} mo`;
}

export function QueueView({ onOpen, compact }: { onOpen: (videoId: string, t: number | null) => void; compact?: boolean }) {
  const [queue, setQueue] = useState<ReviewCard[] | null>(null);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const load = async () => {
    const cards = interleave(await db.dueCardsFromDb());
    setQueue(cards);
    setShown(false);
    setTotal((await db.getAll('cards')).length);
  };
  useEffect(() => {
    load();
  }, []);
  // Cards graded "Again" leave the queue until they are due (10 minutes), then rejoin at the end
  // without disturbing the card on screen.
  const [retryAt, setRetryAt] = useState<number[]>([]);
  useEffect(() => {
    if (!retryAt.length) return;
    const timer = setTimeout(async () => {
      const due = interleave(await db.dueCardsFromDb());
      setQueue((q) => [...(q ?? []), ...due.filter((c) => !(q ?? []).some((x) => x.id === c.id))]);
      setRetryAt((ts) => ts.filter((t) => t > Date.now()));
    }, Math.max(1000, Math.min(...retryAt) - Date.now() + 500));
    return () => clearTimeout(timer);
  }, [retryAt]);

  if (!queue) return <p class="small muted">Loading review cards…</p>;
  const card = queue[0];
  if (!card) {
    return (
      <div class="empty">
        <h2>{done ? 'Review done' : 'Nothing due'}</h2>
        <p class="small">
          {done ? `You reviewed ${done} card${done === 1 ? '' : 's'}. ` : ''}
          {retryAt.length ? `${retryAt.length} marked Again will come back in about 10 minutes. ` : ''}
          {total ? `${total} card${total === 1 ? '' : 's'} scheduled.` : 'Cards come from shaky concepts, missed checkpoints and mistakes.'}
        </p>
      </div>
    );
  }
  const grade = async (g: Grade) => {
    await records.reviewCard(card, g);
    setDone((n) => n + 1);
    setQueue(queue.slice(1));
    if (g === 'again') setRetryAt((ts) => [...ts, schedule(card, 'again').due]);
    setShown(false);
  };
  const now = Date.now();
  return (
    <div class="stack">
      <div class="row small muted">
        <span>
          {queue.length} due · {done} reviewed
        </span>
        <span class="spacer" />
        <span>{card.videoTitle || card.videoId}</span>
      </div>
      <div class="card">
        <div class="row">
          <span class="pill">{{ concept: 'Concept', checkpoint: 'Checkpoint', mistake: 'Mistake', problem: 'Practice' }[card.kind]}</span>
          {card.priority >= 2 && <span class="pill danger">You were sure</span>}
          <span class="spacer" />
          {card.at !== null && (
            <button type="button" class="ts-btn" onClick={() => onOpen(card.videoId, card.at)} title="Open the video at this moment">
              {formatTime(card.at)}
            </button>
          )}
        </div>
        <div class="card-face" style={{ marginTop: 8 }}>
          <Prose md={card.front} onSeek={(t) => onOpen(card.videoId, t)} />
        </div>
        {shown ? (
          <>
            <div class="answer-wrap" style={{ margin: '10px 0' }}>
              <Prose md={card.back} onSeek={(t) => onOpen(card.videoId, t)} />
            </div>
            <div class="grades">
              {(['again', 'hard', 'good', 'easy'] as Grade[]).map((g) => (
                <button type="button" key={g} class={`btn small ${g === 'good' ? 'primary' : ''}`} onClick={() => grade(g)}>
                  <span>
                    {g[0].toUpperCase() + g.slice(1)}
                    {!compact && <span class="muted small"> · {interval(schedule(card, g, now).due - now)}</span>}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <button type="button" class="btn primary small" style={{ marginTop: 10 }} onClick={() => setShown(true)}>
            Show answer
          </button>
        )}
      </div>
      <p class="small muted">Answer in your head (or out loud) before revealing. Cards from different videos are mixed on purpose.</p>
    </div>
  );
}

export function openVideo(videoId: string, t: number | null) {
  chrome.tabs.create({ url: watchUrl(videoId, t ?? undefined) }).catch(() => undefined);
}
