// Transcript with search, click-to-seek, and thumbnails from the frame buffer (§13.2).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatTime } from '../../shared/time';
import type { StoredFrame } from '../../shared/types';
import type { App } from '../state/useApp';
import { FrameThumb } from '../ui';

export function TranscriptView({ app }: { app: App }) {
  const { transcript, captions, t } = app;
  const [filter, setFilter] = useState('');
  const cues = transcript?.cues ?? [];
  const q = filter.trim().toLowerCase();
  const shown = q ? cues.filter((c) => c.text.toLowerCase().includes(q)) : cues;
  const nowIdx = q ? -1 : cues.findIndex((c, i) => c.start <= t && (cues[i + 1]?.start ?? Infinity) > t);
  const nowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    nowRef.current?.scrollIntoView({ block: 'center' });
  }, [nowIdx]);
  // Each kept frame sits above the first line spoken at or after it.
  const thumbAt = useMemo(() => {
    const m = new Map<number, StoredFrame>();
    if (q) return m;
    const frames = app.data.frames.filter((f) => f.kind !== 'ask');
    for (const f of frames) {
      const i = cues.findIndex((c) => c.start + c.duration >= f.t);
      if (i >= 0 && !m.has(i)) m.set(i, f);
    }
    return m;
  }, [app.data.frames, cues, q]);
  if (!transcript) {
    return (
      <div class="empty">
        <h2>{captions.state === 'loading' ? 'Loading captions…' : 'No transcript'}</h2>
        <p class="small">{captions.state === 'loading' ? captions.step : captions.state === 'none' ? captions.reason : 'Captions load when the panel is open on a video.'}</p>
        {captions.state !== 'loading' && (
          <button type="button" class="btn small" onClick={() => app.cs({ type: 'cs/ensure-captions', force: true }).then(app.setCaptions).catch(() => undefined)}>
            Try again
          </button>
        )}
      </div>
    );
  }
  return (
    <>
      <input type="search" style={{ width: '100%', border: '1px solid var(--line-strong)', borderRadius: 8, background: 'var(--surface)', padding: '6px 10px' }} placeholder="Search the transcript" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
      <div class="small muted">
        {transcript.trackName} · {transcript.cues.length} lines · via {transcript.source === 'player' ? 'the player' : transcript.source === 'direct' ? 'direct fetch' : 'the transcript panel'}
      </div>
      <div class="transcript">
        {shown.map((c, i) => (
          <div key={`${c.start}-${i}`}>
            {thumbAt.has(i) && (
              <div style={{ padding: '4px 6px' }}>
                <FrameThumb frame={thumbAt.get(i)!} onClick={() => app.seek(thumbAt.get(i)!.t)} />
              </div>
            )}
            <button type="button" ref={i === nowIdx ? nowRef : undefined} class={`cue ${i === nowIdx ? 'now' : ''}`} onClick={() => app.seek(c.start)}>
              <span class="t">{formatTime(c.start)}</span>
              <span>{c.text}</span>
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
