import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/panel/render';

describe('renderMarkdown', () => {
  it('renders inline and display LaTeX with KaTeX', () => {
    const html = renderMarkdown('The softmax is $\\sigma(z)_i = e^{z_i}/\\sum_j e^{z_j}$.\n\n$$\\frac{\\partial L}{\\partial w}$$');
    expect(html).toContain('class="katex"');
    expect(html).toContain('katex-display');
    expect(html).not.toContain('$');
  });

  it('supports \\( \\) and \\[ \\] delimiters', () => {
    const html = renderMarkdown('inline \\(x^2\\) and\n\\[\\int_0^1 x\\,dx\\]');
    expect((html.match(/class="katex"/g) ?? []).length).toBe(2);
  });

  it('does not treat currency as math', () => {
    const html = renderMarkdown('It costs $5 and $10.');
    expect(html).not.toContain('katex');
    expect(html).toContain('$5 and $10');
  });

  it('highlights fenced code with a copy button and leaves math and timestamps inside code alone', () => {
    const html = renderMarkdown('```python\nx = a[1:30] * 2  # $not math$\n```');
    expect(html).toContain('class="code"');
    expect(html).toContain('data-action="copy"');
    expect(html).toContain('hljs-');
    expect(html).not.toContain('katex');
    expect(html).not.toContain('class="ts"');
  });

  it('turns [m:ss] timestamps into seek buttons, outside code only', () => {
    const html = renderMarkdown('Defined at [12:34], see `[1:00]` and [1:02:03–1:03:00].');
    expect(html).toContain('<button type="button" class="ts" data-t="754"');
    expect(html).toContain('data-t="3723"');
    expect(html).toContain('<code>[1:00]</code>');
  });

  it('escapes raw HTML and refuses unsafe links and remote images', () => {
    const block = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(block).not.toContain('<script');
    expect(block).not.toContain('<img');
    const inline = renderMarkdown('Text <b onclick="x()">bold</b> and [x](javascript:alert(1)) and ![pic](https://evil.example/p.png) and [ok](https://example.com)');
    expect(inline).not.toContain('<b ');
    expect(inline).not.toMatch(/href="javascript/i);
    expect(inline).not.toContain('<img');
    expect(inline).not.toContain('evil.example');
    expect(inline).toContain('[image: pic]');
    expect(inline).toContain('href="https://example.com"');
    expect(inline).toContain('rel="noopener noreferrer"');
  });

  it('survives half-streamed input', () => {
    expect(() => renderMarkdown('Partial $\\frac{a}{')).not.toThrow();
    expect(() => renderMarkdown('```python\ndef f(')).not.toThrow();
  });
});
