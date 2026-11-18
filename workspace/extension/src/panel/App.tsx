// Side panel shell: header, tabs and status, then one view. State lives in state/useApp.ts and
// state/useAsk.ts; each view is in views/.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { modelInfo } from '../shared/settings';
import { useApp, type App as AppState, type View } from './state/useApp';
import { useAsk } from './state/useAsk';
import { Banner, FrameSelect, Icon } from './ui';
import { AskView, Composer } from './views/AskView';
import { PracticeView } from './views/PracticeView';
import { openVideo, QueueView } from './views/QueueView';
import { ReviewView } from './views/ReviewView';
import { TranscriptView } from './views/TranscriptView';
import { WatchView } from './views/WatchView';

const TABS: { id: View; label: string }[] = [
  { id: 'watch', label: 'Watch' },
  { id: 'ask', label: 'Ask' },
  { id: 'practice', label: 'Practice' },
  { id: 'review', label: 'Review' },
  { id: 'transcript', label: 'Transcript' },
];

const openLibrary = () => chrome.tabs.create({ url: chrome.runtime.getURL('library/index.html') });

export function App() {
  const app = useApp();
  const ask = useAsk(app);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Panel shortcuts: "/" focuses the question box, Esc leaves it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.('textarea, input');
      if (e.key === '/' && !typing) {
        e.preventDefault();
        app.setView('ask');
        setTimeout(() => ask.inputRef.current?.focus(), 0);
      } else if (e.key === 'Escape' && typing) (e.target as HTMLElement).blur();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const header = (title: string, withTabs: boolean) => (
    <Header app={app} title={title}>
      {withTabs && (
        <>
          <div class="tabs" role="tablist">
            {TABS.map((v) => (
              <button type="button" role="tab" class="tab" aria-selected={app.view === v.id} key={v.id} onClick={() => app.setView(v.id)}>
                {v.label}
                {v.id === 'watch' && app.checkpointHit && <span class="dot" />}
              </button>
            ))}
          </div>
          <Status app={app} />
        </>
      )}
    </Header>
  );

  // Off YouTube (or on a non-watch page): the review queue works anywhere (§13.4).
  if (!app.tab || !app.isYouTube || (app.content === 'ok' && app.vs && !app.vs.videoId)) {
    return (
      <>
        {header('YouTube Tutor', false)}
        <div class="main" ref={scrollRef}>
          <div class="stack">
            <QueueView onOpen={openVideo} compact />
            <div class="card">
              <p class="small" style={{ margin: 0 }}>
                Open a lecture on youtube.com/watch to ask about it. <span class="kbd">Alt</span>+<span class="kbd">Shift</span>+<span class="kbd">A</span> ask ·{' '}
                <span class="kbd">L</span> I'm lost · <span class="kbd">E</span> explain the screen · <span class="kbd">B</span> bookmark.
              </p>
            </div>
          </div>
        </div>
      </>
    );
  }
  if (app.content === 'missing') {
    return (
      <>
        {header('YouTube Tutor', false)}
        <div class="empty">
          <h2>Reload the YouTube tab</h2>
          <p>The tutor could not connect to this page. Reload the tab and open the panel again.</p>
        </div>
      </>
    );
  }

  const { captions, keyInfo, meta } = app;
  return (
    <>
      {header(meta?.title || 'Loading video…', true)}
      {ask.selecting && ask.frame && <FrameSelect src={ask.frame.dataUrl} onCancel={() => ask.setSelecting(false)} onSelect={ask.applyRegion} />}
      <div class="main" ref={scrollRef}>
        <div class="stack">
          {keyInfo && !keyInfo.hasKey && (
            <Banner kind="warn" action={<button type="button" class="btn small" onClick={() => chrome.runtime.openOptionsPage()}>Settings</button>}>
              Add your Anthropic API key in Settings to ask the tutor. Captions and frames are only sent when you ask.
            </Banner>
          )}
          {meta?.isLive && <Banner kind="warn">Live streams are not supported. The tutor needs a finished video with captions.</Banner>}
          {captions.state === 'none' && (
            <Banner kind="warn" action={<button type="button" class="btn small" onClick={() => app.cs({ type: 'cs/ensure-captions', force: true }).then(app.setCaptions).catch(() => undefined)}>Retry</button>}>
              {captions.reason} Answers will rely on the current frame only.
            </Banner>
          )}
          {app.notice && (
            <Banner kind="info" action={<button type="button" class="btn ghost small" onClick={() => app.setNotice(null)}>Dismiss</button>}>
              {app.notice}
            </Banner>
          )}
          {app.view === 'watch' && <WatchView app={app} ask={ask} />}
          {app.view === 'ask' && <AskView app={app} ask={ask} scrollRef={scrollRef} />}
          {app.view === 'practice' && app.videoId && app.video && (
            <PracticeView
              host={{
                videoId: app.videoId,
                map: app.map,
                learner: app.video.learner,
                problems: app.data.problems,
                hasKey: !!keyInfo?.hasKey,
                jobs: app.jobs,
                runJob: app.runJob,
                onSeek: app.seek,
                focusConcept: app.map && app.section ? app.map.concepts.find((c) => c.definedAt !== null && c.definedAt >= app.section!.start && c.definedAt < app.section!.end)?.name ?? null : null,
                sectionIndex: app.sectionIdx >= 0 ? app.sectionIdx : undefined,
              }}
            />
          )}
          {app.view === 'practice' && !app.video && <p class="small muted">Loading…</p>}
          {app.view === 'review' && <ReviewView app={app} />}
          {app.view === 'transcript' && <TranscriptView app={app} />}
          {app.view === 'queue' && <QueueView onOpen={(vid, t) => (vid === app.videoId && t !== null ? app.seek(t) : openVideo(vid, t))} />}
        </div>
      </div>
      {(app.view === 'ask' || app.view === 'watch') && <Composer app={app} ask={ask} />}
      <span class="sr-only" aria-live="polite">
        {ask.busy ? 'The tutor is answering' : ''}
      </span>
    </>
  );
}

function Header({ app, title, children }: { app: AppState; title: string; children?: ComponentChildren }) {
  return (
    <header class="top">
      <div class="top-row">
        <div class="video-title" title={title}>
          {title}
        </div>
        <button type="button" class="icon-btn" title={`Review queue (${app.due} due)`} aria-label={`Review queue, ${app.due} due`} onClick={() => app.setView(app.view === 'queue' ? 'watch' : 'queue')} style={{ width: 'auto', padding: '0 4px' }}>
          {app.due > 0 ? <span class="badge">{app.due}</span> : <span class="small">Review</span>}
        </button>
        <button type="button" class="icon-btn" title="Library" aria-label="Open the library" onClick={openLibrary}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <path d="M4 4h4v16H4zM10 4h4v16h-4zM16.5 4.5l3.8 1-3.9 15-3.8-1z" />
          </svg>
        </button>
        <button type="button" class="icon-btn" title="Settings" aria-label="Settings" onClick={() => chrome.runtime.openOptionsPage()}>
          <Icon.gear />
        </button>
      </div>
      {children}
    </header>
  );
}

function Status({ app }: { app: AppState }) {
  const { captions } = app;
  const model = modelInfo(app.settings.model);
  return (
    <div class="status-line">
      {captions.state === 'ready' ? (
        <span class="pill" title={`${captions.trackName} via ${captions.source}`}>
          CC {captions.lang}
          {captions.isAuto ? ' auto' : ''}
        </span>
      ) : captions.state === 'loading' ? (
        <span class="pill">Captions: {captions.step}…</span>
      ) : captions.state === 'none' ? (
        <span class="pill amber">No captions</span>
      ) : null}
      {app.jobs.map && !app.jobs.map.result && !app.jobs.map.error && <span class="pill accent">Preparing lesson…</span>}
      {app.video?.playlist && <span class="pill" title={app.video.playlist.title}>Course {app.video.playlist.index + 1}</span>}
      {app.chapter && <span class="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.chapter.title}</span>}
      <span class="spacer" />
      <span class="small" title={model.note}>
        {model.label.replace('Claude ', '')}
      </span>
    </div>
  );
}
