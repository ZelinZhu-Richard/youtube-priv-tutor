// Runs the Python test harness under the bundled Pyodide (Node build of the same package),
// so the harness the sandbox uses is checked against a real Python, not just string-compared.
import { describe, expect, it } from 'vitest';
import { buildPyHarness, parseHarnessResult } from '../src/shared/practice';

describe('Python harness under Pyodide', () => {
  it('runs code, captures stdout, and reports passing and failing tests separately', async () => {
    const { loadPyodide } = await import('pyodide');
    const py = await loadPyodide();
    const src = buildPyHarness('def mean(xs):\n    return sum(xs) / len(xs)\nprint("loaded", mean([1, 2, 3]))', [
      { name: 'simple', code: 'assert mean([2, 4]) == 3' },
      { name: 'wrong', code: 'assert mean([1, 1]) == 2, "mean of ones"' },
      { name: 'error', code: 'mean([])' },
    ]);
    const r = parseHarnessResult(py.runPython(src) as string, 5);
    expect(r.stdout.trim()).toBe('loaded 2.0');
    expect(r.error).toBeNull();
    expect(r.tests.map((t) => [t.name, t.passed])).toEqual([
      ['simple', true],
      ['wrong', false],
      ['error', false],
    ]);
    expect(r.tests[1].message).toBe('mean of ones');
    expect(r.tests[2].message).toMatch(/ZeroDivisionError/);

    const bad = parseHarnessResult(py.runPython(buildPyHarness('def f(:\n  pass', [{ name: 't', code: 'assert True' }])) as string, 1);
    expect(bad.error).toMatch(/SyntaxError/);
    expect(bad.tests).toEqual([]);
  }, 60_000);
});
