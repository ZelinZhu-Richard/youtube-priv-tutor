// Small presentational components for the side panel.
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Rect } from '../shared/image';
import { summarizeRun } from '../shared/practice';
import { formatTime } from '../shared/time';
import type { Bookmark, Confidence, MapCheckpoint, MapSection, StoredFrame } from '../shared/types';
import { renderMarkdown } from './render';
import { languageOf, runCode } from './sandboxClient';

export function Ts({ t, onSeek, label }: { t: number; onSeek: (t: number) => void; label?: string }) {
  return (
    <button type="button" class="ts-btn" title={`Jump to ${formatTime(t)}`} onClick={() => onSeek(t)}>
      {label ?? formatTime(t)}
    </button>
  );
}

/** Rendered Markdown with seekable timestamps and copyable code blocks. */
export function Prose({ md, onSeek }: { md: string; onSeek: (t: number) => void }) {
  const html = useMemo(() => renderMarkdown(md), [md]);
  const onClick = (e: MouseEvent) => {
    const el = e.target as HTMLElement;
    const ts = el.closest<HTMLElement>('button.ts');
    if (ts?.dataset.t) {
      onSeek(Number(ts.dataset.t));
      return;
    }
    const run = el.closest<HTMLElement>('[data-action="run"]');
    if (run) {
      const block = run.closest('.code');
      const lang = languageOf(run.dataset.lang ?? '');
      const out = block?.querySelector<HTMLElement>('.run-out');
      if (!block || !lang || !out) return;
      out.hidden = false;
      out.textContent = lang === 'python' ? 'Running (the first Python run loads Pyodide, a few seconds)…' : 'Running…';
      run.setAttribute('disabled', '');
      runCode(lang, block.querySelector('code')?.textContent ?? '').then((r) => {
        out.textContent = summarizeRun(r);
        out.classList.toggle('fail', !r.ok);
        run.removeAttribute('disabled');
      });
      return;
    }
    const copy = el.closest<HTMLElement>('[data-action="copy"]');
    if (copy) {
      const code = copy.closest('.code')?.querySelector('code')?.textContent ?? '';
      navigator.clipboard
        .writeText(code)
        .then(() => {
          copy.textContent = 'Copied';
          setTimeout(() => (copy.textContent = 'Copy'), 1200);
        })
        .catch(() => undefined);
    }
  };
  return <div class="prose" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Thinking({ text, label = 'Thinking' }: { text: string; label?: string }) {
  return (
    <div class="thinking">
      <span class="pulse" aria-hidden="true" />
      <div>
        {label}…
        {text.trim() && (
          <details>
            <summary class="small">What the tutor is considering</summary>
            <pre>{text.trim().slice(-1500)}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

export function Banner({ kind = 'info', children, action }: { kind?: 'info' | 'warn' | 'error'; children: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class={`banner ${kind === 'info' ? '' : kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div class="grow">{children}</div>
      {action}
    </div>
  );
}

export const Icon = {
  gear: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  ),
  send: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  ),
  refresh: () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
    </svg>
  ),
};

export function Timeline(props: {
  duration: number;
  t: number;
  sections: MapSection[];
  current: number;
  known: ReadonlySet<number>;
  checkpoints: MapCheckpoint[];
  doneIds: ReadonlySet<string>;
  pins: number[];
  bookmarks?: Bookmark[];
  onSeek: (t: number) => void;
}) {
  const { duration, t, sections, current, known, checkpoints, doneIds, pins, onSeek } = props;
  if (!(duration > 0)) return null;
  const pct = (x: number) => `${Math.min(100, Math.max(0, (x / duration) * 100))}%`;
  return (
    <div>
      <div class="timeline">
        <div class="track">
          {sections.length ? (
            sections.map((s, i) => (
              <button
                type="button"
                key={i}
                class={`seg ${i === current ? 'current' : ''} ${known.has(i) ? 'known' : ''}`}
                style={{ flexGrow: Math.max(1, s.end - s.start), flexBasis: 0 }}
                title={`${formatTime(s.start)} ${s.title}${known.has(i) ? ' (known)' : ''}`}
                aria-label={`Section ${i + 1}: ${s.title}, at ${formatTime(s.start)}`}
                onClick={() => onSeek(s.start)}
              />
            ))
          ) : (
            <div class="seg" style={{ flexGrow: 1 }} />
          )}
        </div>
        {checkpoints.map((cp) => (
          <button type="button" key={cp.id} class={`cp ${doneIds.has(cp.id) ? 'done' : ''}`} style={{ left: pct(cp.at) }} title={`Checkpoint at ${formatTime(cp.at)}`} aria-label={`Checkpoint at ${formatTime(cp.at)}`} onClick={() => onSeek(Math.max(0, cp.at - 5))} />
        ))}
        {pins.map((p, i) => (
          <button type="button" key={i} class="pin" style={{ left: pct(p) }} title={`You asked at ${formatTime(p)}`} aria-label={`Your question at ${formatTime(p)}`} onClick={() => onSeek(p)} />
        ))}
        {(props.bookmarks ?? []).map((b) => (
          <button type="button" key={b.id} class="bm" style={{ left: pct(b.t) }} title={`Bookmark ${formatTime(b.t)}${b.note ? `: ${b.note}` : ''}`} aria-label={`Bookmark at ${formatTime(b.t)}`} onClick={() => onSeek(b.t)} />
        ))}
        <div class="playhead" style={{ left: pct(t) }} />
      </div>
      <div class="timeline-legend">
        <span>{formatTime(t)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}

/** Drag a box on the frame to point at a term, line of code or part of a diagram (§12.3). */
export function FrameSelect({ src, onCancel, onSelect }: { src: string; onCancel: () => void; onSelect: (r: Rect) => void }) {
  const area = useRef<HTMLDivElement>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<Rect | null>(null);
  const point = (e: PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const big = !!box && Math.abs(box.width) > 0.02 && Math.abs(box.height) > 0.02;
  const norm = (b: Rect): Rect => ({ x: Math.min(b.x, b.x + b.width), y: Math.min(b.y, b.y + b.height), width: Math.abs(b.width), height: Math.abs(b.height) });
  return (
    <div class="overlay" role="dialog" aria-label="Select a region of the frame">
      <div class="row">
        <strong>Point at it</strong>
        <span class="muted small">Drag a box around the term, line or diagram you mean.</span>
      </div>
      <div
        class="select-area"
        ref={area}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          origin.current = point(e);
          setBox({ ...origin.current, width: 0, height: 0 });
        }}
        onPointerMove={(e) => {
          if (!origin.current) return;
          const p = point(e);
          setBox({ x: origin.current.x, y: origin.current.y, width: p.x - origin.current.x, height: p.y - origin.current.y });
        }}
        onPointerUp={() => (origin.current = null)}
      >
        <img src={src} alt="Current video frame" draggable={false} />
        {box && (
          <div
            class="select-box"
            style={{ left: `${norm(box).x * 100}%`, top: `${norm(box).y * 100}%`, width: `${norm(box).width * 100}%`, height: `${norm(box).height * 100}%` }}
          />
        )}
      </div>
      <div class="row">
        <span class="spacer" />
        <button type="button" class="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" class="btn primary" disabled={!big} onClick={() => box && onSelect(norm(box))}>
          Use this region
        </button>
      </div>
    </div>
  );
}

/** Object URL for a stored frame's blob, revoked when the component goes away. */
export function useBlobUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return setUrl(null);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

export function FrameThumb({ frame, onClick, selected, title }: { frame: StoredFrame; onClick?: () => void; selected?: boolean; title?: string }) {
  const url = useBlobUrl(frame.blob);
  return (
    <button type="button" class={`thumb ${selected ? 'sel' : ''}`} onClick={onClick} title={title ?? `Frame at ${formatTime(frame.t)}`} aria-pressed={selected}>
      {url && <img src={url} alt={`Frame at ${formatTime(frame.t)}`} />}
      <span>{formatTime(frame.t)}</span>
    </button>
  );
}

/** Horizontal strip of stored frames (rolling buffer and bookmarks). */
export function Filmstrip({ frames, onPick, selected, label }: { frames: StoredFrame[]; onPick: (f: StoredFrame) => void; selected?: ReadonlySet<string>; label: string }) {
  if (!frames.length) return null;
  return (
    <div class="filmstrip" role="list" aria-label={label}>
      {frames.map((f) => (
        <FrameThumb key={f.id} frame={f} selected={selected?.has(f.id)} onClick={() => onPick(f)} />
      ))}
    </div>
  );
}

export function ConfidencePicker({ value, onChange }: { value: Confidence | null; onChange: (c: Confidence) => void }) {
  return (
    <div class="row small" role="radiogroup" aria-label="How confident are you?">
      <span class="muted">How sure are you?</span>
      {(['low', 'medium', 'high'] as Confidence[]).map((c) => (
        <button type="button" key={c} role="radio" aria-checked={value === c} class={`btn small ${value === c ? 'primary' : 'ghost'}`} onClick={() => onChange(c)}>
          {{ low: 'Guessing', medium: 'Fairly', high: 'Sure' }[c]}
        </button>
      ))}
    </div>
  );
}

export function VerdictPill({ verdict }: { verdict: 'correct' | 'partial' | 'incorrect' | 'skipped' }) {
  const m = { correct: ['solid', 'Correct'], partial: ['amber', 'Partly right'], incorrect: ['danger', 'Not yet'], skipped: ['', 'Skipped'] } as const;
  const [cls, label] = m[verdict];
  return <span class={`pill ${cls} verdict`}>{label}</span>;
}
