// Library page (§13.5): every video studied, search across notes and transcripts, the concept graph
// (with practice), the mistake log across videos, and the review queue.
import { render } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import 'katex/dist/katex.min.css';
import '../panel/styles.css';
import './library.css';
import * as db from '../shared/db';
import type { DoneResult, PortRequest } from '../shared/messages';
import { ensureMigrated } from '../shared/migrate';
import { buildSearchDocs, conceptIndex, layoutGraph, searchLibrary, tokenize, type LibraryConcept, type SearchDoc } from '../shared/library';
import { sendToBackground } from '../shared/rpc';
import { formatTime, watchUrl } from '../shared/time';
import type { ConceptState, HistoryEntry, Mistake, PracticeProblem, VideoRecord } from '../shared/types';
import { TutorPort } from '../panel/port';
import type { Job } from '../panel/state/useApp';
import { Banner, Prose } from '../panel/ui';
import { PracticeView } from '../panel/views/PracticeView';
import { openVideo, QueueView } from '../panel/views/QueueView';
import { exportZip } from '../panel/views/ReviewView';

type Tab = 'videos' | 'search' | 'concepts' | 'mistakes' | 'review';

const STATE_COLOR: Record<ConceptState, string> = { solid: 'var(--solid-soft)', shaky: 'var(--amber-soft)', seen: 'var(--accent-soft)', unseen: 'var(--surface-2)' };

function useJobs() {
  const port = useMemo(() => new TutorPort(), []);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const runJob = useCallback(
    (key: string, req: Exclude<PortRequest, { type: 'ping' } | { type: 'cancel' } | { type: 'ask' }>, onDone?: (r: DoneResult) => void) => {
      const reqId = req.reqId;
      const upd = (f: (j: Job) => Job) => setJobs((all) => (all[key]?.reqId === reqId ? { ...all, [key]: f(all[key]) } : all));
      setJobs((all) => ({ ...all, [key]: { reqId, text: '', thinking: '' } }));
      port.request(req, {
        onThinking: (d) => upd((j) => ({ ...j, thinking: j.thinking + d })),
        onDelta: (d) => upd((j) => ({ ...j, text: j.text + d })),
        onDone: (res) => {
          upd((j) => ({ ...j, result: res }));
          onDone?.(res);
        },
        onError: (error) => upd((j) => ({ ...j, error })),
      });
    },
    [port],
  );
  return { jobs, runJob };
}

function Library() {
  const [tab, setTab] = useState<Tab>((location.hash.slice(1) as Tab) || 'videos');
  const [videos, setVideos] = useState<VideoRecord[] | null>(null);
  const [qa, setQa] = useState<HistoryEntry[]>([]);
  const [mistakes, setMistakes] = useState<Mistake[]>([]);
  const [docs, setDocs] = useState<SearchDoc[] | null>(null);
  const [problems, setProblems] = useState<PracticeProblem[]>([]);
  const [hasKey, setHasKey] = useState(false);
  const { jobs, runJob } = useJobs();

  const load = useCallback(async () => {
    await ensureMigrated().catch(() => undefined);
    const [vs, hs, ms, ps] = await Promise.all([db.getAll('videos'), db.getAll('history'), db.getAll('mistakes'), db.getAll('problems')]);
    setVideos(vs.map(db.completeVideo).sort((a, b) => b.updatedAt - a.updatedAt));
    setQa(hs);
    setMistakes(ms.sort((a, b) => b.createdAt - a.createdAt));
    setProblems(ps);
    setDocs(null);
  }, []);
  useEffect(() => {
    load();
    sendToBackground({ type: 'bg/has-key' }).then((r) => setHasKey(r.hasKey)).catch(() => undefined);
    const onMsg = (m: { type?: string }) => {
      if (m?.type === 'evt/data') load();
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);
  useEffect(() => {
    window.history.replaceState(null, '', `#${tab}`);
  }, [tab]);

  // Search documents (including transcripts) are built on first use of the Search tab.
  useEffect(() => {
    if (tab !== 'search' || docs || !videos) return;
    (async () => {
      const [bookmarks, transcripts] = await Promise.all([db.getAll('bookmarks'), db.getAll('transcripts')]);
      setDocs(buildSearchDocs({ videos, history: qa, bookmarks, mistakes, transcripts }));
    })();
  }, [tab, docs, videos]);

  const titles = useMemo(() => new Map((videos ?? []).map((v) => [v.videoId, v.title || v.videoId])), [videos]);

  return (
    <main class="lib">
      <div class="row">
        <h1>Library</h1>
        <span class="spacer" />
        <a class="btn ghost small" href="../options/index.html">
          Settings
        </a>
      </div>
      <div class="tabs" role="tablist">
        {(['videos', 'search', 'concepts', 'mistakes', 'review'] as Tab[]).map((t) => (
          <button type="button" role="tab" class="tab" aria-selected={tab === t} key={t} onClick={() => setTab(t)}>
            {{ videos: 'Videos', search: 'Search', concepts: 'Concepts', mistakes: 'Mistakes', review: 'Review' }[t]}
          </button>
        ))}
      </div>
      {!videos ? (
        <p class="muted">Loading…</p>
      ) : (
        <>
          {tab === 'videos' && <Videos videos={videos} history={qa} problems={problems} />}
          {tab === 'search' && <Search docs={docs} titles={titles} />}
          {tab === 'concepts' && <Concepts videos={videos} problems={problems} jobs={jobs} runJob={runJob} hasKey={hasKey} reload={load} />}
          {tab === 'mistakes' && <Mistakes mistakes={mistakes} titles={titles} />}
          {tab === 'review' && <QueueView onOpen={openVideo} />}
        </>
      )}
    </main>
  );
}

function hm(sec: number) {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function Videos({ videos, history, problems }: { videos: VideoRecord[]; history: HistoryEntry[]; problems: PracticeProblem[] }) {
  if (!videos.length) return <div class="empty"><h2>No videos yet</h2><p>Open a lecture on YouTube with the side panel open; it appears here once captions load or you ask a question.</p></div>;
  return (
    <div class="vgrid">
      {videos.map((v) => {
        const states = Object.values(v.learner.concepts).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }), {});
        const notes = history.filter((h) => h.videoId === v.videoId).length;
        const practice = problems.filter((p) => p.videoId === v.videoId && p.attempts.length).length;
        const pct = v.lengthSeconds ? Math.min(100, Math.round((v.lastT / v.lengthSeconds) * 100)) : 0;
        return (
          <div class="card vcard" key={v.videoId}>
            <h3>{v.title || v.videoId}</h3>
            <div class="meta">
              {v.channel}
              {v.playlist ? ` · ${v.playlist.title} #${v.playlist.index + 1}` : ''}
            </div>
            <div class="progress" title={`${pct}% watched`}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <div class="meta">
              {formatTime(v.lastT)} of {formatTime(v.lengthSeconds)} · {hm(v.timeSpentSec)} studied · {notes} question{notes === 1 ? '' : 's'}
              {practice ? ` · ${practice} practised` : ''}
            </div>
            <div class="states" style={{ margin: '8px 0' }}>
              {(['solid', 'shaky', 'seen'] as const).map((s) => states[s] ? <span key={s} class={`pill ${s === 'solid' ? 'solid' : s === 'shaky' ? 'amber' : ''}`}>{states[s]} {s}</span> : null)}
              {!v.map && <span class="pill">no lesson map</span>}
            </div>
            <div class="row">
              <a class="btn small primary" href={watchUrl(v.videoId, v.lastT || undefined)} target="_blank" rel="noopener noreferrer">
                {v.lastT > 30 ? 'Resume' : 'Open'}
              </a>
              <button type="button" class="btn small" onClick={() => exportZip(v.videoId)}>
                Notes (.zip)
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Search({ docs, titles }: { docs: SearchDoc[] | null; titles: Map<string, string> }) {
  const [q, setQ] = useState('');
  const hits = useMemo(() => (docs && q.trim() ? searchLibrary(docs, q) : []), [docs, q]);
  const terms = tokenize(q);
  const mark = (s: string) => {
    if (!terms.length) return s;
    const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return s.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
  };
  return (
    <>
      <input type="search" autoFocus placeholder="Search your questions, answers, bookmarks, mistakes, cheat sheets and transcripts" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      {!docs && <p class="small muted">Indexing…</p>}
      {docs && q.trim() && <p class="small muted">{hits.length ? `${hits.length} result${hits.length === 1 ? '' : 's'}` : 'No results.'}</p>}
      <div>
        {hits.map((h, i) => (
          <div class="hit" key={i}>
            <div class="row small">
              <span class="pill">{h.kind}</span>
              <strong>{titles.get(h.videoId) ?? h.videoId}</strong>
              {h.at !== null && (
                <a class="ts-btn" href={watchUrl(h.videoId, h.at)} target="_blank" rel="noopener noreferrer">
                  {formatTime(h.at)}
                </a>
              )}
            </div>
            <div class="snip">{mark(h.snippet)}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function Concepts(props: { videos: VideoRecord[]; problems: PracticeProblem[]; jobs: Record<string, Job>; runJob: ReturnType<typeof useJobs>['runJob']; hasKey: boolean; reload: () => void }) {
  const index = useMemo(() => conceptIndex(props.videos), [props.videos]);
  const nodes = useMemo(() => [...index.values()], [index]);
  const placed = useMemo(() => layoutGraph(nodes.map((n) => ({ key: n.key, deps: n.dependsOn.map((d) => d.toLowerCase()) }))), [nodes]);
  const [sel, setSel] = useState<string | null>(null);
  const [practice, setPractice] = useState(false);
  if (!nodes.length) return <div class="empty"><h2>No concepts yet</h2><p>Concepts come from lesson maps. Prepare the lesson on a video to see them here.</p></div>;
  const W = 190;
  const H = 34;
  const pos = new Map(placed.map((p) => [p.key, { x: 16 + p.level * (W + 46), y: 16 + p.row * (H + 14) }]));
  const width = Math.max(...placed.map((p) => p.level)) * (W + 46) + W + 32;
  const height = Math.max(...placed.map((p) => p.row)) * (H + 14) + H + 32;
  const c: LibraryConcept | undefined = sel ? index.get(sel) : undefined;
  const home = c ? [...c.occurrences].reverse().find((o) => props.videos.find((v) => v.videoId === o.videoId)?.map) : undefined;
  const homeVideo = home ? props.videos.find((v) => v.videoId === home.videoId) : undefined;
  return (
    <div class="graph-wrap">
      <div>
        <div class="legend" style={{ marginBottom: 6 }}>
          {(['solid', 'shaky', 'seen', 'unseen'] as ConceptState[]).map((s) => (
            <span key={s}>
              <i style={{ background: STATE_COLOR[s] }} />
              {s}
            </span>
          ))}
          <span>· arrows point from a concept to what builds on it</span>
        </div>
        <div class="graph">
          <svg width={width} height={height} role="img" aria-label="Concept graph">
            <defs>
              <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0 10 5 0 10z" fill="var(--line-strong)" />
              </marker>
            </defs>
            {nodes.flatMap((n) =>
              n.dependsOn
                .map((d) => d.toLowerCase())
                .filter((d) => pos.has(d))
                .map((d) => {
                  const a = pos.get(d)!;
                  const b = pos.get(n.key)!;
                  return <path key={`${d}->${n.key}`} class="edge" marker-end="url(#arr)" d={`M${a.x + W} ${a.y + H / 2} C ${a.x + W + 24} ${a.y + H / 2}, ${b.x - 24} ${b.y + H / 2}, ${b.x} ${b.y + H / 2}`} />;
                }),
            )}
            {nodes.map((n) => {
              const p = pos.get(n.key)!;
              return (
                <g
                  key={n.key}
                  class={`node ${sel === n.key ? 'sel' : ''}`}
                  transform={`translate(${p.x},${p.y})`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${n.name}, ${n.state}`}
                  onClick={() => {
                    setSel(n.key);
                    setPractice(false);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && setSel(n.key)}
                >
                  <rect width={W} height={H} rx={8} fill={STATE_COLOR[n.state]} />
                  <text x={10} y={H / 2 + 4}>
                    {n.name.length > 26 ? `${n.name.slice(0, 25)}…` : n.name}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      <div class="card">
        {!c ? (
          <p class="small muted" style={{ margin: 0 }}>Click a concept to see where it was taught and to practise it.</p>
        ) : (
          <>
            <h3>{c.name}</h3>
            <span class={`pill ${c.state === 'solid' ? 'solid' : c.state === 'shaky' ? 'amber' : ''}`}>{c.state}</span>
            {c.dependsOn.length > 0 && <p class="small">Builds on: {c.dependsOn.join(', ')}</p>}
            <div class="eyebrow" style={{ marginTop: 8 }}>Taught in</div>
            <ul class="list" style={{ marginTop: 6 }}>
              {c.occurrences.map((o) => (
                <li key={o.videoId} style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                  <span>
                    <a href={watchUrl(o.videoId, o.definedAt ?? undefined)} target="_blank" rel="noopener noreferrer">
                      {o.title || o.videoId}
                    </a>
                    {o.definedAt !== null && ` at ${formatTime(o.definedAt)}`} <span class="pill">{o.state}</span>
                  </span>
                  {o.summary && <span class="small muted">{o.summary}</span>}
                </li>
              ))}
            </ul>
            {homeVideo && (
              <button type="button" class="btn primary small" style={{ marginTop: 10 }} onClick={() => setPractice(true)}>
                Practise {c.name}
              </button>
            )}
          </>
        )}
      </div>
      {practice && homeVideo && c && (
        <div style={{ gridColumn: '1 / -1' }}>
          {!props.hasKey && <Banner kind="warn">Add your API key in Settings to generate practice problems.</Banner>}
          <PracticeView
            host={{
              videoId: homeVideo.videoId,
              map: homeVideo.map,
              learner: homeVideo.learner,
              // Every set for this video, newest first and labelled by concept: the form's dropdown can
              // pick a different concept than the one clicked in the graph, and its set must still show.
              problems: props.problems.filter((p) => p.videoId === homeVideo.videoId),
              hasKey: props.hasKey,
              jobs: props.jobs,
              runJob: (key, req, onDone) => props.runJob(key, req, (r) => { props.reload(); onDone?.(r); }),
              onSeek: (t) => openVideo(homeVideo.videoId, t),
              focusConcept: homeVideo.map?.concepts.find((x) => x.name.toLowerCase() === c.key)?.name ?? null,
            }}
          />
        </div>
      )}
    </div>
  );
}

function Mistakes({ mistakes, titles }: { mistakes: Mistake[]; titles: Map<string, string> }) {
  const [q, setQ] = useState('');
  const terms = tokenize(q);
  const shown = terms.length ? mistakes.filter((m) => terms.every((t) => `${m.question} ${m.answer} ${m.misconception} ${m.correction}`.toLowerCase().includes(t))) : mistakes;
  if (!mistakes.length) return <div class="empty"><h2>No mistakes logged</h2><p>Wrong or partial answers to checkpoints, practice, quizzes and prerequisite checks collect here.</p></div>;
  return (
    <>
      <input type="search" placeholder="Search the mistake log" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <div>
        {shown.map((m) => (
          <div class="hit" key={m.id}>
            <div class="row small">
              <span class="pill">{m.source}</span>
              {m.confidence === 'high' && <span class="pill danger">was sure</span>}
              <strong>{titles.get(m.videoId) ?? m.videoId}</strong>
              {m.at !== null && (
                <a class="ts-btn" href={watchUrl(m.videoId, m.at)} target="_blank" rel="noopener noreferrer">
                  {formatTime(m.at)}
                </a>
              )}
            </div>
            <Prose md={m.question} onSeek={(t) => openVideo(m.videoId, t)} />
            {m.misconception && <p class="small" style={{ margin: '2px 0' }}>Misconception: {m.misconception}</p>}
            {m.correction && (
              <div class="small muted">
                <Prose md={`Correction: ${m.correction}`} onSeek={(t) => openVideo(m.videoId, t)} />
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

render(<Library />, document.getElementById('app')!);
