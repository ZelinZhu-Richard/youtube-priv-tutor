// Practice (§13.3): problem schema and normalisation, worked-example fading, the hint ladder,
// confidence calibration, and the test harnesses the code sandbox runs. Pure functions.
import type { CodeSpec, Confidence, PracticeProblem, ProblemKind, RunResult, Verdict } from './types';

export const PRACTICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['problems'],
  properties: {
    problems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['level', 'kind', 'statement', 'steps', 'answer', 'hints', 'code_language', 'starter_code', 'tests'],
        properties: {
          level: { type: 'integer', description: '1, 2 or 3' },
          kind: { type: 'string', enum: ['math', 'code', 'concept'] },
          statement: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' }, description: 'Worked solution, one step per item' },
          answer: { type: 'string' },
          hints: { type: 'array', items: { type: 'string' }, description: 'Exactly three: a nudge, which idea to use, the first step' },
          code_language: { type: 'string', enum: ['none', 'javascript', 'python'] },
          starter_code: { type: 'string' },
          tests: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'code'],
              properties: { name: { type: 'string' }, code: { type: 'string', description: 'Raises/throws on failure (Python assert / JS assert(cond, msg))' } },
            },
          },
        },
      },
    },
  },
} as const;

const s = (x: unknown, max = 4000) => (typeof x === 'string' ? x.trim().slice(0, max) : '');

export function normalizeProblems(raw: unknown, ctx: { videoId: string; concept: string; setId: string; now?: number; id: (i: number) => string }): PracticeProblem[] {
  const list = Array.isArray((raw as { problems?: unknown })?.problems) ? ((raw as { problems: unknown[] }).problems as Record<string, unknown>[]) : [];
  const out: PracticeProblem[] = [];
  for (const [i, p] of list.entries()) {
    const statement = s(p.statement);
    if (!statement) continue;
    const kind: ProblemKind = p.kind === 'code' || p.kind === 'math' ? p.kind : 'concept';
    const lang = p.code_language === 'javascript' || p.code_language === 'python' ? p.code_language : null;
    const tests = Array.isArray(p.tests) ? (p.tests as Record<string, unknown>[]).map((t, k) => ({ name: s(t.name, 100) || `test ${k + 1}`, code: s(t.code, 2000) })).filter((t) => t.code) : [];
    const code: CodeSpec | null = kind === 'code' && lang ? { language: lang, starter: s(p.starter_code, 8000), tests: tests.slice(0, 12) } : null;
    const hints = (Array.isArray(p.hints) ? (p.hints as unknown[]).map((h) => s(h, 800)).filter(Boolean) : []).slice(0, 3);
    while (hints.length < 3) hints.push(hints.length === 0 ? 'Reread the problem: what is given, and what is asked?' : 'Look back at how the video handled the same idea.');
    const level = Math.min(3, Math.max(1, Math.round(Number(p.level) || out.length + 1))) as 1 | 2 | 3;
    out.push({
      id: ctx.id(i),
      videoId: ctx.videoId,
      concept: ctx.concept,
      setId: ctx.setId,
      level,
      kind: code ? 'code' : kind === 'code' ? 'concept' : kind,
      statement,
      steps: Array.isArray(p.steps) ? (p.steps as unknown[]).map((x) => s(x, 1500)).filter(Boolean).slice(0, 12) : [],
      answer: s(p.answer),
      hints,
      code,
      attempts: [],
      createdAt: ctx.now ?? Date.now(),
    });
  }
  return out.sort((a, b) => a.level - b.level).slice(0, 3);
}

/**
 * Worked-example fading: level 1 shows the full worked solution, level 2 hides the last third of
 * the steps (at least one) for the learner to complete, level 3 shows none.
 */
export function visibleSteps(p: Pick<PracticeProblem, 'level' | 'steps'>): { shown: string[]; blanks: number } {
  if (p.level === 1) return { shown: p.steps, blanks: 0 };
  if (p.level === 3) return { shown: [], blanks: 0 };
  const hide = Math.max(1, Math.ceil(p.steps.length / 3));
  const keep = Math.max(0, p.steps.length - hide);
  return { shown: p.steps.slice(0, keep), blanks: p.steps.length - keep };
}

/** Hint ladder rungs; the fourth rung is the full solution. */
export const HINT_LADDER = ['Nudge', 'Which idea to use', 'First step', 'Full solution'] as const;

export interface HintView {
  label: string;
  text: string;
}

/** What is revealed after `used` hints. */
export function revealedHints(p: Pick<PracticeProblem, 'hints' | 'steps' | 'answer'>, used: number): HintView[] {
  const n = Math.min(Math.max(0, used), HINT_LADDER.length);
  const out: HintView[] = [];
  for (let i = 0; i < n; i++) {
    const text = i < 3 ? p.hints[i] ?? '' : [...p.steps.map((st, k) => `${k + 1}. ${st}`), p.answer && `**Answer:** ${p.answer}`].filter(Boolean).join('\n');
    out.push({ label: HINT_LADDER[i], text });
  }
  return out;
}

export function nextHint(used: number): number {
  return Math.min(HINT_LADDER.length, used + 1);
}

// ---------- confidence ----------

export function isSureButWrong(confidence: Confidence | null | undefined, verdict: Verdict | 'skipped'): boolean {
  return confidence === 'high' && verdict === 'incorrect';
}

export interface CalibrationRow {
  confidence: Confidence;
  n: number;
  correct: number;
  partial: number;
  incorrect: number;
  /** Share fully correct, 0..1, or null with no data. */
  accuracy: number | null;
}

export function calibration(items: { confidence?: Confidence | null; verdict: Verdict | 'skipped' }[]): { rows: CalibrationRow[]; sureButWrong: number; total: number } {
  const levels: Confidence[] = ['low', 'medium', 'high'];
  const rows = levels.map((confidence) => {
    const mine = items.filter((i) => i.confidence === confidence && i.verdict !== 'skipped');
    const count = (v: Verdict) => mine.filter((i) => i.verdict === v).length;
    return { confidence, n: mine.length, correct: count('correct'), partial: count('partial'), incorrect: count('incorrect'), accuracy: mine.length ? count('correct') / mine.length : null };
  });
  return { rows, sureButWrong: items.filter((i) => isSureButWrong(i.confidence, i.verdict)).length, total: rows.reduce((n, r) => n + r.n, 0) };
}

// ---------- sandbox harnesses ----------

/**
 * JavaScript run in the sandbox worker as an async function body (so code and tests may await).
 * User code sits in its own block, so it may declare names the harness also uses, and tests in
 * the same block see its declarations; each test runs in its own try/catch.
 */
export function buildJsHarness(code: string, tests: { name: string; code: string }[]): string {
  const testBlocks = tests
    .map(
      (t) => `try {\n${t.code}\n;__results.push({ name: ${JSON.stringify(t.name)}, passed: true, message: '' });\n} catch (__e) { __results.push({ name: ${JSON.stringify(t.name)}, passed: false, message: String(__e && __e.message || __e) }); }`,
    )
    .join('\n');
  return `const __fmt = (v) => { if (typeof v === 'string') return v; try { return JSON.stringify(v); } catch { return String(v); } };
const console = { log: (...a) => __logs.push(a.map(__fmt).join(' ')), info: (...a) => __logs.push(a.map(__fmt).join(' ')), warn: (...a) => __logs.push(a.map(__fmt).join(' ')), error: (...a) => __logs.push(a.map(__fmt).join(' ')) };
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(actual, expected, msg) { const a = JSON.stringify(actual), b = JSON.stringify(expected); if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'expected ' + b + ', got ' + a); }
{
${code}
;
${testBlocks}
}`;
}

/** Python run by Pyodide; the last expression is the JSON result. */
export function buildPyHarness(code: string, tests: { name: string; code: string }[]): string {
  const testList = `[${tests.map((t) => `(${JSON.stringify(t.name)}, ${JSON.stringify(t.code)})`).join(', ')}]`;
  return `import sys, io, json, traceback
__out = io.StringIO()
__ns = {'__name__': '__main__'}
__results = []
__err = None
__real_stdout, __real_stderr = sys.stdout, sys.stderr
sys.stdout = sys.stderr = __out
try:
    exec(compile(${JSON.stringify(code)}, '<your code>', 'exec'), __ns)
except BaseException:
    __err = traceback.format_exc(limit=4)
if __err is None:
    for __name, __code in ${testList}:
        try:
            exec(compile(__code, __name, 'exec'), __ns)
            __results.append({'name': __name, 'passed': True, 'message': ''})
        except AssertionError as __e:
            __results.append({'name': __name, 'passed': False, 'message': str(__e) or 'assertion failed'})
        except BaseException as __e:
            __results.append({'name': __name, 'passed': False, 'message': type(__e).__name__ + ': ' + str(__e)})
sys.stdout, sys.stderr = __real_stdout, __real_stderr
json.dumps({'stdout': __out.getvalue()[-20000:], 'error': __err, 'tests': __results})`;
}

export function parseHarnessResult(json: string, ms: number): RunResult {
  try {
    const r = JSON.parse(json) as { stdout?: string; error?: string | null; tests?: RunResult['tests'] };
    const tests = Array.isArray(r.tests) ? r.tests : [];
    return { ok: !r.error && tests.every((t) => t.passed), stdout: r.stdout ?? '', error: r.error ?? null, tests, timedOut: false, ms };
  } catch {
    return { ok: false, stdout: '', error: 'Could not read the sandbox result.', tests: [], timedOut: false, ms };
  }
}

/** Plain-text summary of a run, given to the tutor when grading code. */
export function summarizeRun(r: RunResult): string {
  const lines: string[] = [];
  if (r.timedOut) lines.push(`Timed out after ${Math.round(r.ms / 1000)} s.`);
  if (r.error) lines.push(`Error:\n${r.error.slice(0, 1500)}`);
  for (const t of r.tests) lines.push(`${t.passed ? 'PASS' : 'FAIL'} ${t.name}${t.message ? `: ${t.message}` : ''}`);
  if (r.stdout.trim()) lines.push(`Output:\n${r.stdout.trim().slice(-1500)}`);
  if (!lines.length) lines.push('Ran with no output.');
  return lines.join('\n');
}
