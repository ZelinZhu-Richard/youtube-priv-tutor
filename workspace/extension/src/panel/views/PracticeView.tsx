// Practice (§13.3): problem sets per concept with worked-example fading, the hint ladder, a code
// editor that runs tests in the sandbox, a confidence rating before grading, and attempt history.
// Shared by the side panel and the library page.
import { useMemo, useState } from 'preact/hooks';
import type { DoneResult, PortRequest } from '../../shared/messages';
import { HINT_LADDER, nextHint, revealedHints, summarizeRun, visibleSteps } from '../../shared/practice';
import { uid } from '../../shared/rpc';
import type { Confidence, PracticeProblem, RunResult, VideoMap, LearnerModel } from '../../shared/types';
import type { Job } from '../state/useApp';
import { runCode } from '../sandboxClient';
import { Banner, ConfidencePicker, Prose, Thinking, VerdictPill } from '../ui';

export interface PracticeHost {
  videoId: string;
  map: VideoMap | null;
  learner: LearnerModel;
  problems: PracticeProblem[];
  hasKey: boolean;
  jobs: Record<string, Job>;
  runJob: (key: string, req: Exclude<PortRequest, { type: 'ping' } | { type: 'cancel' } | { type: 'ask' }>, onDone?: (r: DoneResult) => void) => void;
  onSeek: (t: number) => void;
  /** Concept to put first (e.g. from the current section or the concept graph). */
  focusConcept?: string | null;
  sectionIndex?: number;
}

const LEVEL_LABEL = { 1: 'Worked example', 2: 'Finish the solution', 3: 'On your own' } as const;

export function PracticeView({ host }: { host: PracticeHost }) {
  const concepts = useMemo(() => {
    const all = host.map?.concepts ?? [];
    const state = (n: string) => host.learner.concepts[n]?.state ?? 'unseen';
    const rank = (n: string) => (n === host.focusConcept ? -1 : state(n) === 'shaky' ? 0 : state(n) === 'seen' ? 1 : state(n) === 'unseen' ? 2 : 3);
    return [...all].sort((a, b) => rank(a.name) - rank(b.name) || (a.definedAt ?? 0) - (b.definedAt ?? 0));
  }, [host.map, host.learner, host.focusConcept]);
  const [concept, setConcept] = useState<string>('');
  const chosen = concept || concepts[0]?.name || '';
  const sets = useMemo(() => {
    const by = new Map<string, PracticeProblem[]>();
    for (const p of host.problems) by.set(p.setId, [...(by.get(p.setId) ?? []), p]);
    return [...by.values()].map((ps) => ps.sort((a, b) => a.level - b.level)).sort((a, b) => b[0].createdAt - a[0].createdAt);
  }, [host.problems]);
  const job = host.jobs.practice;
  const generating = !!job && !job.result && !job.error;

  if (!host.map) return <div class="empty"><h2>Practice</h2><p class="small">Prepare the lesson first (Watch tab); practice is built on its concepts.</p></div>;

  const start = () =>
    host.runJob('practice', { type: 'practice', reqId: uid('p'), videoId: host.videoId, concept: chosen, sectionIndex: host.sectionIndex ?? null });

  return (
    <div class="stack">
      <div class="card">
        <div class="eyebrow">New practice set</div>
        <p class="small muted" style={{ margin: '4px 0 8px' }}>
          Three new problems on one concept, in a different setting from the video: a worked example to study, one to finish, one on your own.
        </p>
        <div class="row" style={{ flexWrap: 'nowrap' }}>
          <select value={chosen} onChange={(e) => setConcept((e.target as HTMLSelectElement).value)} style={{ flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--line-strong)', background: 'var(--surface)' }}>
            {concepts.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
                {host.learner.concepts[c.name]?.state === 'shaky' ? ' (shaky)' : host.learner.concepts[c.name]?.state === 'solid' ? ' (solid)' : ''}
              </option>
            ))}
          </select>
          <button type="button" class="btn primary small" disabled={!chosen || !host.hasKey || generating} onClick={start}>
            Make problems
          </button>
        </div>
        {generating && <Thinking text={job.thinking} label="Writing problems" />}
        {job?.error && <Banner kind="error">{job.error.message}</Banner>}
      </div>
      {sets.map((ps) => (
        <div class="stack" key={ps[0].setId}>
          <div class="eyebrow">{ps[0].concept}</div>
          {ps.map((p) => (
            <ProblemCard key={p.id} problem={p} host={host} />
          ))}
        </div>
      ))}
    </div>
  );
}

function ProblemCard({ problem, host }: { problem: PracticeProblem; host: PracticeHost }) {
  const [hints, setHints] = useState(0);
  const [answer, setAnswer] = useState('');
  const [code, setCode] = useState(problem.code?.starter ?? '');
  const [run, setRun] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const job = host.jobs[`problem:${problem.id}`];
  const grading = !!job && !job.result && !job.error;
  const { shown, blanks } = visibleSteps(problem);
  const last = problem.attempts[problem.attempts.length - 1];
  const result = job?.result?.kind === 'grade-problem' ? job.result.attempt : null;

  const doRun = async () => {
    if (!problem.code) return;
    setRunning(true);
    setRun(await runCode(problem.code.language, code, problem.code.tests));
    setRunning(false);
  };
  const grade = async () => {
    let r = run;
    if (problem.code && !r) {
      setRunning(true);
      r = await runCode(problem.code.language, code, problem.code.tests);
      setRun(r);
      setRunning(false);
    }
    host.runJob(`problem:${problem.id}`, { type: 'grade-problem', reqId: uid('g'), problemId: problem.id, answer, code: problem.code ? code : null, run: r, hintsUsed: hints, confidence });
  };

  return (
    <div class="card">
      <div class="row">
        <span class="pill accent">
          {problem.level}. {LEVEL_LABEL[problem.level]}
        </span>
        {problem.code && <span class="pill">{problem.code.language}</span>}
        {last && <VerdictPill verdict={last.verdict} />}
      </div>
      <div style={{ marginTop: 8 }}>
        <Prose md={problem.statement} onSeek={host.onSeek} />
      </div>
      {problem.level !== 3 && problem.steps.length > 0 && (
        <ol class="steps">
          {shown.map((s, i) => (
            <li key={i}>
              <Prose md={s} onSeek={host.onSeek} />
            </li>
          ))}
          {Array.from({ length: blanks }, (_, i) => (
            <li key={`b${i}`} class="blank">
              your step
            </li>
          ))}
        </ol>
      )}
      {problem.level === 1 && problem.answer && <Prose md={`**Answer:** ${problem.answer}`} onSeek={host.onSeek} />}

      {revealedHints(problem, hints).map((h) => (
        <div class="hint" key={h.label}>
          <div class="label">{h.label}</div>
          <Prose md={h.text} onSeek={host.onSeek} />
        </div>
      ))}

      {problem.code ? (
        <>
          <textarea class="codebox" spellcheck={false} value={code} onInput={(e) => setCode((e.target as HTMLTextAreaElement).value)} aria-label="Your code" />
          <div class="row">
            <button type="button" class="btn small" onClick={doRun} disabled={running}>
              {running ? 'Running…' : 'Run tests'}
            </button>
            <span class="small muted">Runs locally in a sandbox with no network.{problem.code.language === 'python' ? ' The first Python run loads Pyodide.' : ''}</span>
          </div>
          {run && <pre class={`run-out ${run.ok ? '' : 'fail'}`} style={{ borderRadius: 8, border: '1px solid var(--line)' }}>{summarizeRun(run)}</pre>}
        </>
      ) : null}
      {problem.level !== 1 || problem.code ? (
        <textarea value={answer} placeholder={problem.code ? 'Optional: explain your approach' : 'Your answer and working'} onInput={(e) => setAnswer((e.target as HTMLTextAreaElement).value)} />
      ) : (
        <textarea value={answer} placeholder="Explain each step in your own words (self-explanation)" onInput={(e) => setAnswer((e.target as HTMLTextAreaElement).value)} />
      )}
      <ConfidencePicker value={confidence} onChange={setConfidence} />
      <div class="row" style={{ marginTop: 8 }}>
        <button type="button" class="btn primary small" disabled={!host.hasKey || grading || !confidence || (!answer.trim() && !(problem.code && code.trim()))} onClick={grade} title={!confidence ? 'Rate your confidence first' : ''}>
          Check
        </button>
        <button type="button" class="btn ghost small" disabled={hints >= HINT_LADDER.length} onClick={() => setHints(nextHint(hints))}>
          {hints < HINT_LADDER.length ? `Hint: ${HINT_LADDER[hints].toLowerCase()}` : 'All hints shown'}
        </button>
      </div>
      {grading && <Thinking text={job.thinking} label="Grading" />}
      {job?.text && (
        <div style={{ marginTop: 8 }}>
          {result && <VerdictPill verdict={result.verdict} />}
          <Prose md={result ? result.feedback : job.text.replace(/\n\s*\**(VERDICT|CONCEPTS|MISCONCEPTION|CORRECTION)[\s\S]*$/i, '')} onSeek={host.onSeek} />
        </div>
      )}
      {job?.error && <Banner kind="error">{job.error.message}</Banner>}
      {problem.attempts.length > 0 && !job && (
        <p class="small muted" style={{ marginBottom: 0 }}>
          {problem.attempts.length} attempt{problem.attempts.length > 1 ? 's' : ''}; last used {last.hintsUsed} hint{last.hintsUsed === 1 ? '' : 's'}.
        </p>
      )}
    </div>
  );
}
