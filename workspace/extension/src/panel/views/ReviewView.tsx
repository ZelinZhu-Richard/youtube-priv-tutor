// Reviewing state (§12.5, §13.3, §13.4).
import { useMemo, useState } from 'preact/hooks';
import * as db from '../../shared/db';
import { assembleNotesZip, buildCards, slug, toAnkiCsv } from '../../shared/export';
import { conceptsInState } from '../../shared/learner';
import { tokenize } from '../../shared/library';
import { calibration } from '../../shared/practice';
import * as records from '../../shared/records';
import { uid } from '../../shared/rpc';
import { formatTime } from '../../shared/time';
import type { QuizItem } from '../../shared/types';
import { buildZip } from '../../shared/zip';
import type { App } from '../state/useApp';
import { Banner, Prose, Thinking, Ts, VerdictPill } from '../ui';

export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function exportZip(videoId: string) {
  const [video, history, bookmarks, mistakes, frames] = await Promise.all([db.getVideo(videoId), db.byVideo('history', videoId), db.byVideo('bookmarks', videoId), db.byVideo('mistakes', videoId), db.byVideo('frames', videoId)]);
  if (!video) return;
  const used = new Set([...bookmarks.map((b) => b.frameId), ...history.map((h) => h.frameId)]);
  const frameBytes = await Promise.all(frames.filter((f) => used.has(f.id)).map(async (f) => ({ id: f.id, t: f.t, bytes: new Uint8Array(await f.blob.arrayBuffer()), mime: f.blob.type || 'image/jpeg' })));
  const entries = assembleNotesZip({
    meta: video,
    history: history.sort((a, b) => a.createdAt - b.createdAt),
    map: video.map,
    learner: video.learner,
    checkpoints: video.checkpointResults,
    teachBacks: video.teachBacks,
    bookmarks,
    mistakes,
    feynman: video.feynman,
    cheatSheet: video.cheatSheet?.markdown ?? null,
    frames: frameBytes,
  });
  download(`${slug(video.title || videoId)}-${videoId}.zip`, buildZip(entries) as BlobPart, 'application/zip');
}

export function ReviewView({ app }: { app: App }) {
  const { video, map, data } = app;
  const [revealed, setRevealed] = useState<Record<number, 'shown' | 'got' | 'missed'>>({});
  const [feynman, setFeynman] = useState('');
  const [mistakeQuery, setMistakeQuery] = useState('');
  const cal = useMemo(
    () =>
      calibration([
        ...(video?.checkpointResults ?? []).map((r) => ({ confidence: r.confidence, verdict: r.verdict })),
        ...data.problems.flatMap((p) => p.attempts.map((a) => ({ confidence: a.confidence, verdict: a.verdict }))),
      ]),
    [video?.checkpointResults, data.problems],
  );
  if (!video || !app.videoId) return <p class="small muted">Loading…</p>;
  const videoId = app.videoId;
  const shaky = conceptsInState(video.learner, 'shaky');
  const solid = conceptsInState(video.learner, 'solid');
  const fJob = app.jobs.feynman;
  const cJob = app.jobs.cheatsheet;
  const qJob = app.jobs.quiz;
  const terms = tokenize(mistakeQuery);
  const mistakes = terms.length ? data.mistakes.filter((m) => terms.every((t) => `${m.question} ${m.misconception} ${m.correction}`.toLowerCase().includes(t))) : data.mistakes;
  const quiz: QuizItem[] = video.quiz;

  return (
    <>
      <div class="card">
        <div class="eyebrow">Key ideas</div>
        {map ? (
          <ul class="list" style={{ marginTop: 8 }}>
            {map.sections.map((s, i) => (
              <li key={i}>
                <Ts t={s.start} onSeek={app.seek} />
                <span>
                  <strong>{s.title}.</strong> {s.keyIdea}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p class="small muted">Prepare the lesson (Watch tab) to get a summary of the key ideas.</p>
        )}
      </div>

      {video.preQuestions.some((q) => q.guess) && (
        <div class="card">
          <div class="eyebrow">Your guesses before watching</div>
          {video.preQuestions.map((q, i) => (
            <div key={i} class="quiz-item">
              <Prose md={q.question} onSeek={app.seek} />
              <p class="small" style={{ margin: '4px 0' }}>
                <span class="muted">You guessed:</span> {q.guess || '—'}
              </p>
              <div class="answer-wrap">
                <Prose md={`${q.answer}${q.at !== null ? ` [${formatTime(q.at)}]` : ''}`} onSeek={app.seek} />
              </div>
            </div>
          ))}
        </div>
      )}

      <div class="card">
        <div class="eyebrow">Explain the whole video (Feynman summary)</div>
        {video.feynman && !fJob ? (
          <>
            <span class={`pill ${video.feynman.verdict === 'solid' ? 'solid' : 'amber'}`}>{video.feynman.verdict === 'solid' ? 'Solid' : 'Gaps found'}</span>
            <blockquote class="small" style={{ margin: '8px 0', color: 'var(--ink-2)' }}>{video.feynman.text}</blockquote>
            <Prose md={video.feynman.feedback} onSeek={app.seek} />
            {video.feynman.missing.length > 0 && <p class="small">Missing: {video.feynman.missing.join('; ')}</p>}
            <button type="button" class="btn ghost small" onClick={() => app.updateVideo(() => ({ feynman: null }))}>
              Try again
            </button>
          </>
        ) : (
          <>
            <textarea value={feynman} placeholder="The main idea of this video in a few sentences, as if teaching a friend." onInput={(e) => setFeynman((e.target as HTMLTextAreaElement).value)} />
            <button type="button" class="btn primary small" disabled={!feynman.trim() || !app.keyInfo?.hasKey || !map || (!!fJob && !fJob.result && !fJob.error)} onClick={() => app.runJob('feynman', { type: 'feynman', reqId: uid('f'), videoId, text: feynman }, () => { app.reload(); app.clearJob('feynman'); })}>
              Grade my summary
            </button>
            {fJob && !fJob.text && !fJob.error && <Thinking text={fJob.thinking} label="Comparing with the lesson map" />}
            {fJob?.text && !fJob.result && <Prose md={fJob.text.replace(/\n\s*\**(VERDICT|MISSING)[\s\S]*$/i, '')} onSeek={app.seek} />}
            {fJob?.error && <Banner kind="error">{fJob.error.message}</Banner>}
          </>
        )}
      </div>

      <div class="card">
        <div class="row">
          <div class="eyebrow">Cheat sheet</div>
          <span class="spacer" />
          <button type="button" class="btn small" disabled={!app.keyInfo?.hasKey || (!!cJob && !cJob.result && !cJob.error)} onClick={() => app.runJob('cheatsheet', { type: 'cheatsheet', reqId: uid('c'), videoId }, () => { app.reload(); app.clearJob('cheatsheet'); })}>
            {video.cheatSheet ? 'Regenerate' : 'Make cheat sheet'}
          </button>
        </div>
        {cJob && !cJob.result && !cJob.error && (cJob.text ? <Prose md={cJob.text} onSeek={app.seek} /> : <Thinking text={cJob.thinking} label="Writing the cheat sheet" />)}
        {cJob?.error && <Banner kind="error">{cJob.error.message}</Banner>}
        {video.cheatSheet && !cJob && <Prose md={video.cheatSheet.markdown} onSeek={app.seek} />}
      </div>

      <div class="card">
        <div class="eyebrow">Concepts to revisit</div>
        {shaky.length ? (
          <ul class="list" style={{ marginTop: 8 }}>
            {shaky.map((name) => {
              const c = map?.concepts.find((x) => x.name === name);
              return (
                <li key={name}>
                  {c?.definedAt != null ? <Ts t={c.definedAt} onSeek={app.seek} /> : <span class="pill">—</span>}
                  <span>
                    <strong>{name}</strong>
                    {c?.summary ? ` — ${c.summary}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p class="small muted">Nothing marked shaky yet.</p>
        )}
        {solid.length > 0 && <p class="small muted" style={{ marginBottom: 0 }}>Solid: {solid.join(', ')}</p>}
      </div>

      {cal.total > 0 && (
        <div class="card">
          <div class="eyebrow">Calibration</div>
          <p class="small muted" style={{ margin: '4px 0 8px' }}>How often you were right at each confidence level (checkpoints and practice).</p>
          <table class="calib">
            <thead>
              <tr>
                <th>Confidence</th>
                <th>Answers</th>
                <th>Fully right</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cal.rows.map((r) => (
                <tr key={r.confidence}>
                  <td>{{ low: 'Guessing', medium: 'Fairly sure', high: 'Sure' }[r.confidence]}</td>
                  <td>{r.n}</td>
                  <td>{r.accuracy === null ? '—' : `${Math.round(r.accuracy * 100)}%`}</td>
                  <td>
                    <div class="bar">
                      <span style={{ width: `${Math.round((r.accuracy ?? 0) * 100)}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cal.sureButWrong > 0 && <p class="small" style={{ marginBottom: 0 }}><span class="pill danger">{cal.sureButWrong} sure but wrong</span> These are reviewed first.</p>}
        </div>
      )}

      {video.checkpointResults.length > 0 && (
        <div class="card">
          <div class="eyebrow">Checkpoints</div>
          <ul class="list" style={{ marginTop: 8 }}>
            {video.checkpointResults.map((r) => (
              <li key={r.checkpointId}>
                <Ts t={r.at} onSeek={app.seek} />
                <span>
                  {r.question} <VerdictPill verdict={r.verdict} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.mistakes.length > 0 && (
        <div class="card">
          <div class="row">
            <div class="eyebrow">Mistake log</div>
            <span class="spacer" />
            <input type="search" placeholder="Search" value={mistakeQuery} onInput={(e) => setMistakeQuery((e.target as HTMLInputElement).value)} style={{ width: 140 }} />
          </div>
          <ul class="list" style={{ marginTop: 8 }}>
            {mistakes.map((m) => (
              <li key={m.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
                <span>
                  {m.at !== null && <Ts t={m.at} onSeek={app.seek} />} <span class="pill">{m.source}</span> {m.confidence === 'high' && <span class="pill danger">was sure</span>} {m.question}
                </span>
                {m.misconception && <span class="small">Misconception: {m.misconception}</span>}
                {m.correction && <span class="small muted">Correction: {m.correction}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div class="card">
        <div class="row">
          <div class="eyebrow">Final quiz</div>
          <span class="spacer" />
          <button type="button" class="btn small" disabled={!app.keyInfo?.hasKey || (!!qJob && !qJob.result && !qJob.error)} onClick={() => { setRevealed({}); app.runJob('quiz', { type: 'quiz', reqId: uid('z'), videoId, upTo: Math.max(app.t, video.lastT) || app.duration }, () => { app.reload(); app.clearJob('quiz'); }); }}>
            {quiz.length ? 'New quiz' : 'Make a quiz'}
          </button>
        </div>
        {qJob && !qJob.result && !qJob.error && <Thinking text={qJob.thinking} label="Writing questions weighted to your shaky concepts" />}
        {qJob?.error && <Banner kind="error">{qJob.error.message}</Banner>}
        {!qJob &&
          quiz.map((q, i) => (
            <div class="quiz-item" key={i} style={{ marginTop: 10 }}>
              <div class="row">
                <span class="pill">{q.concept || 'Question'}</span>
                {q.at !== null && <Ts t={q.at} onSeek={app.seek} />}
              </div>
              <Prose md={q.question} onSeek={app.seek} />
              {revealed[i] ? (
                <>
                  <div class="answer-wrap" style={{ marginTop: 6 }}>
                    <Prose md={q.answer} onSeek={app.seek} />
                  </div>
                  {revealed[i] === 'shown' ? (
                    <div class="row" style={{ marginTop: 6 }}>
                      <button type="button" class="btn small" onClick={() => { setRevealed({ ...revealed, [i]: 'got' }); if (q.concept) app.learn({ type: 'quiz', correct: true, concepts: [q.concept], note: 'final quiz' }); }}>
                        I got it
                      </button>
                      <button
                        type="button"
                        class="btn ghost small"
                        onClick={() => {
                          setRevealed({ ...revealed, [i]: 'missed' });
                          if (q.concept) app.learn({ type: 'quiz', correct: false, concepts: [q.concept], note: 'final quiz' });
                          records.addMistake({ videoId, at: q.at, source: 'quiz', question: q.question, answer: '', misconception: '', correction: q.answer, confidence: null, concepts: q.concept ? [q.concept] : [] }, video.title).then(() => app.reload());
                        }}
                      >
                        I missed it
                      </button>
                    </div>
                  ) : (
                    <span class={`pill ${revealed[i] === 'got' ? 'solid' : 'amber'}`}>{revealed[i] === 'got' ? 'Got it' : 'Missed'}</span>
                  )}
                </>
              ) : (
                <button type="button" class="btn ghost small" onClick={() => setRevealed({ ...revealed, [i]: 'shown' })}>
                  Show answer
                </button>
              )}
            </div>
          ))}
      </div>

      <div class="card">
        <div class="eyebrow">Export</div>
        <p class="small muted" style={{ margin: '4px 0 8px' }}>
          The zip holds notes.md, cheat-sheet.md and an images folder with your bookmark and question frames (opens as an Obsidian vault folder). Flashcards come from shaky concepts and missed checkpoints (Anki: File › Import).
        </p>
        <div class="row">
          <button type="button" class="btn small" onClick={() => exportZip(videoId)}>
            Notes with frames (.zip)
          </button>
          <button
            type="button"
            class="btn small"
            onClick={() => {
              const cards = buildCards({ meta: video, map, learner: video.learner, checkpoints: video.checkpointResults });
              if (!cards.length) app.setNotice('No flashcards yet: they come from shaky concepts and missed checkpoints.');
              else download(`anki-${videoId}.csv`, toAnkiCsv(cards), 'text/csv');
            }}
          >
            Anki cards (.csv)
          </button>
          <span class="spacer" />
          <button
            type="button"
            class="btn ghost small"
            onClick={async () => {
              if (!confirm('Delete the notes, history, frames, bookmarks, practice, review cards and progress stored for this video? This cannot be undone.')) return;
              await db.clearVideoData(videoId);
              records.notifyChanged(videoId, ['video', 'cards']);
              app.reload();
            }}
          >
            Clear this video's data
          </button>
        </div>
      </div>
    </>
  );
}
