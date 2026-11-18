// Watching state (§12.2, §13.1, §13.2, §13.5).
import { useEffect, useMemo, useState } from 'preact/hooks';
import * as db from '../../shared/db';
import { glossaryEntries } from '../../shared/glossary';
import { splitDataUrl } from '../../shared/image';
import { earlierInPlaylist, findPriorTeaching } from '../../shared/library';
import * as records from '../../shared/records';
import { sendToBackground, uid } from '../../shared/rpc';
import { formatTime } from '../../shared/time';
import type { Confidence, MapCheckpoint, VideoRecord } from '../../shared/types';
import type { Ask } from '../state/useAsk';
import type { App } from '../state/useApp';
import { Banner, ConfidencePicker, Filmstrip, Prose, Thinking, Timeline, Ts, VerdictPill } from '../ui';
import { openVideo } from './QueueView';

export function WatchView({ app, ask }: { app: App; ask: Ask }) {
  const { map, video, section, sectionIdx, t, duration, known, data } = app;
  const [library, setLibrary] = useState<VideoRecord[]>([]);
  useEffect(() => {
    db.getAll('videos').then((vs) => setLibrary(vs.map(db.completeVideo)));
  }, [app.videoId, map]);
  const [resumeDismissed, setResumeDismissed] = useState(false);
  const [goal, setGoal] = useState('');
  const [teach, setTeach] = useState<{ sectionIndex: number; draft: string } | null>(null);
  useEffect(() => {
    setResumeDismissed(false);
    setTeach(null);
  }, [app.videoId]);

  const resume = !resumeDismissed && video && video.lastT > 60 && t < 20 && app.player && !app.player.ended ? video.lastT : null;
  const busy = ask.busy;
  const keyless = !app.keyInfo?.hasKey;

  return (
    <>
      <CourseCard app={app} library={library} />
      {resume !== null && (
        <div class="card">
          <div class="eyebrow">Where was I</div>
          {map ? (
            <ul class="list" style={{ margin: '6px 0 10px' }}>
              {map.sections
                .filter((s) => s.start < resume)
                .slice(-3)
                .map((s) => (
                  <li key={s.start}>
                    <Ts t={s.start} onSeek={app.seek} />
                    <span>{s.keyIdea || s.title}</span>
                  </li>
                ))}
            </ul>
          ) : (
            <p class="small muted">You stopped at {formatTime(resume)} last time.</p>
          )}
          <div class="row">
            <button type="button" class="btn primary small" onClick={() => { app.seek(resume); setResumeDismissed(true); }}>
              Resume at {formatTime(resume)}
            </button>
            {!map && <button type="button" class="btn small" onClick={() => { app.seek(resume); setResumeDismissed(true); setTimeout(() => ask.ask('recap', ''), 400); }}>Recap with the tutor</button>}
            <button type="button" class="btn ghost small" onClick={() => setResumeDismissed(true)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {/* Keyed by video so answers typed for one video never carry over to the next. */}
      <PreWatch key={app.videoId ?? 'none'} app={app} ask={ask} library={library} />
      <CheckpointCard app={app} />

      {app.confusion && (
        <div class="chips">
          <button type="button" class="chip amber" onClick={() => { app.setConfusion(null); ask.ask('lost', ''); }}>
            {app.confusion.why === 'rewound' ? `You rewound ${formatTime(app.confusion.from)}–${formatTime(app.confusion.to)} twice.` : 'Long pause on a busy screen.'} Want help with this part?
          </button>
          <button type="button" class="btn ghost small" onClick={() => app.setConfusion(null)}>
            Not now
          </button>
        </div>
      )}
      {app.speed && app.speed.reason !== 'normal' && (
        <div class="row small muted">
          <span>
            Smart speed: {app.speed.rate}× for this section ({app.speed.reason === 'known' ? 'you know it' : app.speed.reason === 'shaky' ? 'shaky concepts' : 'dense material'}).
          </span>
          <button type="button" class="btn ghost small" onClick={() => app.cs({ type: 'cs/set-rate', rate: app.speed!.base })}>
            Use {app.speed.base}×
          </button>
        </div>
      )}
      {app.skip && (
        <div class="chips">
          <button type="button" class="chip amber" onClick={() => app.seek(app.skip!.to)}>
            You marked this part as known. Skip to {formatTime(app.skip.to)}
          </button>
        </div>
      )}

      {map && section ? (
        <div class={`card section-card ${known.has(sectionIdx) ? 'known' : ''}`}>
          <div class="row">
            <span class="eyebrow">
              Section {sectionIdx + 1} of {map.sections.length}
            </span>
            <span class="spacer" />
            <Ts t={section.start} onSeek={app.seek} label={`${formatTime(section.start)}–${formatTime(section.end)}`} />
          </div>
          <h3 style={{ marginTop: 4 }}>{section.title}</h3>
          {section.keyIdea && <p class="key-idea">{section.keyIdea}</p>}
          <Timeline duration={duration} t={t} sections={map.sections} current={sectionIdx} known={known} checkpoints={app.settings.checkpointMode === 'off' ? [] : map.checkpoints} doneIds={app.doneIds} pins={data.history.map((h) => h.at)} bookmarks={data.bookmarks} onSeek={app.seek} />
          <Filmstrip frames={data.frames.filter((f) => f.kind !== 'ask')} onPick={(f) => app.seek(f.t)} label="Frames kept from this video" />
          <div class="row" style={{ marginTop: 8 }}>
            <button type="button" class="btn small" onClick={() => setTeach({ sectionIndex: sectionIdx, draft: '' })}>
              Explain it back
            </button>
            <button type="button" class="btn small" onClick={() => app.setView('practice')}>
              Practice
            </button>
            <button
              type="button"
              class="btn ghost small"
              aria-pressed={known.has(sectionIdx)}
              onClick={() => app.updateVideo((v) => ({ known: v.known.includes(sectionIdx) ? v.known.filter((x) => x !== sectionIdx) : [...v.known, sectionIdx].sort((a, b) => a - b) }))}
            >
              {known.has(sectionIdx) ? 'Marked as known' : 'I know this'}
            </button>
          </div>
        </div>
      ) : (
        <div class="card">
          <div class="eyebrow">Lesson</div>
          {app.jobs.map && !app.jobs.map.error && !app.jobs.map.result ? (
            <Thinking text={app.jobs.map.thinking} label="Reading the transcript and preparing the lesson map" />
          ) : (
            <>
              <p class="small muted" style={{ margin: '4px 0 8px' }}>
                {app.captions.state === 'ready'
                  ? 'Prepare a lesson map: sections, key ideas, concepts, notation, pre-questions, prerequisite checks, suggested questions and checkpoints. One call over the full transcript.'
                  : 'The lesson map needs captions.'}
              </p>
              {app.jobs.map?.error && <Banner kind="error">{app.jobs.map.error.message}</Banner>}
              <button type="button" class="btn primary small" disabled={app.captions.state !== 'ready' || keyless} onClick={() => app.videoId && app.runJob('map', { type: 'map', reqId: uid('m'), videoId: app.videoId })}>
                Prepare lesson
              </button>
            </>
          )}
          {duration > 0 && <Timeline duration={duration} t={t} sections={[]} current={-1} known={known} checkpoints={[]} doneIds={app.doneIds} pins={data.history.map((h) => h.at)} bookmarks={data.bookmarks} onSeek={app.seek} />}
          <Filmstrip frames={data.frames.filter((f) => f.kind !== 'ask')} onPick={(f) => app.seek(f.t)} label="Frames kept from this video" />
        </div>
      )}

      {teach && <TeachBack app={app} sectionIndex={teach.sectionIndex} onClose={() => setTeach(null)} />}

      {section && section.questions.length > 0 && (
        <div>
          <div class="eyebrow" style={{ marginBottom: 6 }}>Good questions here</div>
          <div class="chips">
            {section.questions.map((q) => (
              <button type="button" class="chip" key={q} onClick={() => ask.ask('question', q)}>
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      <div class="row">
        <button type="button" class="btn" onClick={() => { app.cs({ type: 'cs/pause' }).catch(() => undefined); ask.ask('lost', ''); }} disabled={busy}>
          I'm lost
        </button>
        <button type="button" class="btn" onClick={() => ask.ask('explain-screen', '')} disabled={busy}>
          Explain this screen
        </button>
        <button type="button" class="btn ghost" onClick={() => app.tab && sendToBackground({ type: 'bg/bookmark', tabId: app.tab.id }).then(() => app.reload())} title="Bookmark this moment (Alt+Shift+B)">
          Bookmark
        </button>
      </div>

      <GlossaryCard app={app} />
      <BookmarksCard app={app} />

      {map && (
        <div class="card">
          <div class="eyebrow">What do you want from this video?</div>
          <div class="row" style={{ marginTop: 6, flexWrap: 'nowrap' }}>
            <input type="text" value={goal} placeholder="e.g. understand why attention is scaled by √d" onInput={(e) => setGoal((e.target as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === 'Enter' && goal.trim()) { ask.ask('goal', goal.trim()); setGoal(''); } }} />
            <button type="button" class="btn small" disabled={!goal.trim()} onClick={() => { ask.ask('goal', goal.trim()); setGoal(''); }}>
              Plan
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** "Previously in this course" for videos opened from a playlist (§13.5). */
function CourseCard({ app, library }: { app: App; library: VideoRecord[] }) {
  const pl = app.video?.playlist;
  const earlier = useMemo(() => (pl ? earlierInPlaylist(library, pl.id, pl.index) : []), [library, pl?.id, pl?.index]);
  const [hidden, setHidden] = useState(false);
  if (!pl || !earlier.length || hidden || app.t > 120) return null;
  return (
    <div class="card">
      <div class="row">
        <span class="eyebrow">Previously in {pl.title || 'this course'}</span>
        <span class="spacer" />
        <button type="button" class="btn ghost small" onClick={() => setHidden(true)}>
          Hide
        </button>
      </div>
      <ul class="list" style={{ marginTop: 6 }}>
        {earlier.slice(-3).map((v) => (
          <li key={v.videoId}>
            <span class="pill">{v.playlist!.index + 1}</span>
            <span>
              <strong>{v.title}</strong>
              {v.map?.sections.length ? ` — ${v.map.sections.slice(0, 3).map((s) => s.keyIdea || s.title).join(' ')}` : ''}
            </span>
          </li>
        ))}
      </ul>
      <p class="small muted" style={{ marginBottom: 0 }}>What you found solid or shaky there carries into this video.</p>
    </div>
  );
}

/** Pre-questions and the prerequisite check, before watching (§13.1). */
function PreWatch({ app, ask, library }: { app: App; ask: Ask; library: VideoRecord[] }) {
  const v = app.video;
  const [open, setOpen] = useState(true);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const job = app.jobs.prereq;
  if (!v?.map || !open) return null;
  const pre = v.preQuestions;
  const checks = v.prereqChecks;
  const graded = checks.some((c) => c.ok !== undefined);
  const started = app.t > 90 && !graded;
  if (started || (!pre.length && !checks.length)) return null;
  const solid = (name: string) => Object.entries(v.learner.concepts).some(([n, r]) => r.state === 'solid' && n.toLowerCase() === name.toLowerCase());
  const pending = checks.filter((c) => !solid(c.prerequisite));
  return (
    <div class="card">
      <div class="row">
        <span class="eyebrow">Before you watch</span>
        <span class="spacer" />
        <button type="button" class="btn ghost small" onClick={() => setOpen(false)}>
          Skip
        </button>
      </div>
      {pre.length > 0 && (
        <>
          <p class="small muted" style={{ margin: '6px 0' }}>
            Guess first, even if you are unsure; the answers come back in Review.
          </p>
          {pre.map((q, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <Prose md={q.question} onSeek={app.seek} />
              <input
                type="text"
                value={q.guess ?? ''}
                placeholder="Your guess"
                onChange={(e) => {
                  const guess = (e.target as HTMLInputElement).value;
                  app.updateVideo((cur) => ({ preQuestions: cur.preQuestions.map((x, k) => (k === i ? { ...x, guess } : x)) }));
                }}
              />
            </div>
          ))}
        </>
      )}
      {checks.length > 0 && (
        <>
          <div class="eyebrow" style={{ marginTop: 10 }}>Quick prerequisite check</div>
          {pending.length < checks.length && <p class="small muted">Skipping {checks.length - pending.length} you already know from earlier in the course.</p>}
          {!graded ? (
            <>
              {pending.map((c) => {
                const i = checks.indexOf(c);
                return (
                  <div key={i} style={{ marginTop: 8 }}>
                    <span class="pill">{c.prerequisite}</span>
                    <Prose md={c.question} onSeek={app.seek} />
                    <input type="text" value={answers[i] ?? ''} placeholder="Short answer" onInput={(e) => setAnswers({ ...answers, [i]: (e.target as HTMLInputElement).value })} />
                  </div>
                );
              })}
              <div class="row" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  class="btn primary small"
                  disabled={!app.keyInfo?.hasKey || (!!job && !job.result && !job.error) || !pending.length}
                  onClick={() => app.videoId && app.runJob('prereq', { type: 'prereq-grade', reqId: uid('r'), videoId: app.videoId, checks: pending.map((c) => ({ ...c, response: answers[checks.indexOf(c)] ?? '' })) })}
                >
                  Check
                </button>
              </div>
              {job && !job.result && !job.error && <Thinking text={job.thinking} label="Checking" />}
              {job?.error && <Banner kind="error">{job.error.message}</Banner>}
            </>
          ) : (
            <ul class="list" style={{ marginTop: 6 }}>
              {checks.map((c, i) => {
                const prior = c.ok ? null : findPriorTeaching(c.prerequisite, library, v.videoId);
                return (
                  <li key={i} style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                    <span>
                      <span class={`pill ${c.ok ? 'solid' : 'amber'}`}>{c.ok ? 'OK' : 'Gap'}</span> <strong>{c.prerequisite}</strong>
                      {c.gap ? ` — ${c.gap}` : ''}
                    </span>
                    {!c.ok && (
                      <span class="row">
                        <button type="button" class="btn small" onClick={() => ask.ask('primer', `${c.prerequisite}${c.gap ? ` (gap: ${c.gap})` : ''}${prior ? `. It was taught in the learner's earlier video "${prior.title}".` : ''}`)}>
                          Two-minute primer
                        </button>
                        {prior && (
                          <button type="button" class="btn ghost small" onClick={() => openVideo(prior.videoId, prior.at)}>
                            Rewatch in “{prior.title.slice(0, 40)}”
                          </button>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** The checkpoint the grading job belongs to. Kept outside the card so switching panel tabs and
 * coming back (which remounts the card) does not throw away an answer that is being graded. */
let gradedCheckpoint: string | null = null;

function CheckpointCard({ app }: { app: App }) {
  const hit = app.checkpointHit;
  const cp: MapCheckpoint | undefined = hit ? app.map?.checkpoints.find((c) => c.id === hit.id) : undefined;
  const [draft, setDraft] = useState('');
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  useEffect(() => {
    const id = hit?.id ?? null;
    if (id === gradedCheckpoint) return;
    gradedCheckpoint = id;
    setDraft('');
    setConfidence(null);
    app.clearJob('grade');
  }, [hit?.id]);
  if (!hit || !cp) return null;
  const job = app.jobs.grade;
  const result = job?.result?.kind === 'grade' ? job.result.result : null;
  const close = async (skip: boolean) => {
    if (skip && app.videoId) {
      await records.saveCheckpointResult(app.videoId, { checkpointId: cp.id, question: cp.question, at: cp.at, answer: '', verdict: 'skipped', feedback: '', concepts: cp.concepts, createdAt: Date.now(), confidence: null });
      app.reload();
    }
    if (hit.paused) app.cs({ type: 'cs/play' }).catch(() => undefined);
    app.setCheckpointHit(null);
  };
  return (
    <div class="card">
      <div class="row">
        <span class="pill amber">Checkpoint · {cp.type.replace('-', ' ')}</span>
        <Ts t={cp.at} onSeek={app.seek} />
      </div>
      <h3 style={{ marginTop: 8 }}>{cp.question}</h3>
      {!result && (
        <>
          <textarea value={draft} placeholder="Your answer, in a sentence or two…" onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} />
          <ConfidencePicker value={confidence} onChange={setConfidence} />
          <div class="row" style={{ marginTop: 8 }}>
            <button
              type="button"
              class="btn primary small"
              disabled={!draft.trim() || !confidence || (!!job && !job.error)}
              title={!confidence ? 'Rate your confidence first' : ''}
              onClick={() => app.videoId && app.runJob('grade', { type: 'grade', reqId: uid('g'), videoId: app.videoId, checkpointId: cp.id, answer: draft, confidence }, () => app.reload())}
            >
              Check my answer
            </button>
            <button type="button" class="btn ghost small" onClick={() => close(true)}>
              Skip
            </button>
          </div>
        </>
      )}
      {job && !job.text && !job.error && <Thinking text={job.thinking} label="Reading your answer" />}
      {job?.text && (
        <div style={{ marginTop: 10 }}>
          {result && <VerdictPill verdict={result.verdict} />}
          {result?.confidence === 'high' && result.verdict === 'incorrect' && <span class="pill danger">Sure but wrong: this goes to the front of your review queue</span>}
          <Prose md={result ? result.feedback : job.text.replace(/\n\s*\**(VERDICT|CONCEPTS|MISCONCEPTION|CORRECTION)[\s\S]*$/i, '')} onSeek={app.seek} />
        </div>
      )}
      {job?.error && <Banner kind="error">{job.error.message}</Banner>}
      {result && (
        <button type="button" class="btn primary small" style={{ marginTop: 8 }} onClick={() => close(false)}>
          {hit.paused ? 'Continue watching' : 'Done'}
        </button>
      )}
    </div>
  );
}

/** The video and section the teach-back job belongs to, kept outside the card so reopening the
 * same section (which remounts the card) keeps feedback that was paid for. */
let teachKey: string | null = null;

function TeachBack({ app, sectionIndex, onClose }: { app: App; sectionIndex: number; onClose: () => void }) {
  const [draft, setDraft] = useState('');
  const job = app.jobs.teach;
  const result = job?.result?.kind === 'teachback' ? job.result.result : null;
  useEffect(() => {
    const key = `${app.videoId}:${sectionIndex}`;
    if (key === teachKey) return;
    teachKey = key;
    app.clearJob('teach');
  }, [app.videoId, sectionIndex]);
  return (
    <div class="card">
      <div class="eyebrow">Explain it back</div>
      <h3>{app.map?.sections[sectionIndex]?.title}</h3>
      {!result && (
        <>
          <textarea value={draft} placeholder="In your own words: what is the idea of this section, and why does it work?" onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} />
          <div class="row">
            <button type="button" class="btn primary small" disabled={!draft.trim() || (!!job && !job.error)} onClick={() => app.videoId && app.runJob('teach', { type: 'teachback', reqId: uid('t'), videoId: app.videoId, sectionIndex, text: draft }, () => app.reload())}>
              Get feedback
            </button>
            <button type="button" class="btn ghost small" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
      {job && !job.text && !job.error && <Thinking text={job.thinking} label="Reading your explanation" />}
      {job?.text && (
        <div style={{ marginTop: 8 }}>
          {result && <span class={`pill ${result.verdict === 'solid' ? 'solid' : 'amber'}`}>{result.verdict === 'solid' ? 'Solid' : 'Gaps found'}</span>}
          <Prose md={result ? result.feedback : job.text.replace(/\n\s*\**(VERDICT|CONCEPTS)[\s\S]*$/i, '')} onSeek={app.seek} />
        </div>
      )}
      {job?.error && <Banner kind="error">{job.error.message}</Banner>}
      {result && (
        <div class="row" style={{ marginTop: 8 }}>
          <button type="button" class="btn small" onClick={onClose}>
            Close
          </button>
          <button type="button" class="btn ghost small" onClick={() => { setDraft(''); app.clearJob('teach'); }}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

/** Running table of symbols and terms as they are introduced (§13.2). */
function GlossaryCard({ app }: { app: App }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false);
  const entries = useMemo(() => glossaryEntries(app.map, app.video?.glossaryExtra ?? []), [app.map, app.video?.glossaryExtra]);
  const job = app.jobs.notation;
  if (!app.map && !entries.length) return null;
  const readFrame = async () => {
    const f = await app.cs({ type: 'cs/capture-frame' }).catch(() => null);
    const parts = f?.ok ? splitDataUrl(f.dataUrl) : null;
    if (!f?.ok || !parts || !app.videoId) {
      app.setNotice('Could not capture the frame to read notation from.');
      return;
    }
    app.runJob('notation', { type: 'notation', reqId: uid('n'), videoId: app.videoId, t: f.t, frame: { mediaType: parts.mediaType as 'image/jpeg', data: parts.data, width: f.width, height: f.height } }, () => app.reload());
  };
  return (
    <div class="card">
      <div class="row">
        <button type="button" class="btn ghost small" aria-expanded={open} onClick={() => setOpen(!open)} style={{ padding: 0 }}>
          <span class="eyebrow">Notation and glossary ({entries.filter((e) => e.at === null || e.at <= app.t + 1).length})</span>
        </button>
        <span class="spacer" />
        {open && (
          <label class="small muted">
            <input type="checkbox" checked={all} onChange={(e) => setAll((e.target as HTMLInputElement).checked)} /> show ahead
          </label>
        )}
      </div>
      {open && (
        <>
          <table class="gloss">
            <tbody>
              {entries
                .filter((e) => all || e.at === null || e.at <= app.t + 1)
                .map((e) => (
                  <tr key={`${e.kind}:${e.label}`} class={e.at !== null && e.at > app.t + 1 ? 'future' : ''}>
                    <td>{e.kind === 'symbol' ? <Prose md={`$${e.label}$`} onSeek={app.seek} /> : <strong>{e.label}</strong>}</td>
                    <td>
                      <Prose md={e.meaning} onSeek={app.seek} />
                    </td>
                    <td>{e.at !== null && <Ts t={e.at} onSeek={app.seek} />}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <div class="row" style={{ marginTop: 8 }}>
            <button type="button" class="btn small" disabled={!app.keyInfo?.hasKey || (!!job && !job.result && !job.error)} onClick={readFrame}>
              Add notation from this frame
            </button>
            {job && !job.result && !job.error && <Thinking text="" label="Reading the frame" />}
          </div>
          {job?.error && <Banner kind="error">{job.error.message}</Banner>}
        </>
      )}
    </div>
  );
}

function BookmarksCard({ app }: { app: App }) {
  const marks = app.data.bookmarks;
  const [editing, setEditing] = useState<string | null>(null);
  if (!marks.length) return null;
  return (
    <div class="card">
      <div class="eyebrow">Bookmarks</div>
      <ul class="list" style={{ marginTop: 6 }}>
        {marks.map((b) => (
          <li key={b.id}>
            <Ts t={b.t} onSeek={app.seek} />
            {editing === b.id ? (
              <input
                type="text"
                autoFocus
                defaultValue={b.note}
                placeholder="Note"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
                }}
                onBlur={async (e) => {
                  await records.updateBookmark({ ...b, note: (e.target as HTMLInputElement).value });
                  setEditing(null);
                  app.reload();
                }}
              />
            ) : (
              <span style={{ flex: 1 }} onClick={() => setEditing(b.id)} title="Click to add a note">
                {b.note || <span class="muted">{b.caption || 'Add a note'}</span>}
              </span>
            )}
            <button type="button" class="btn ghost small" aria-label="Delete bookmark" onClick={async () => { await records.deleteBookmark(b); app.reload(); }}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
