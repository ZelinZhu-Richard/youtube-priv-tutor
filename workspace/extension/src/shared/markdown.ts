// Markdown + KaTeX + timestamp rendering core, shared by the side panel and the fullscreen overlay.
// Math and timestamps are swapped for placeholders before Markdown parsing (outside code), then
// rendered back in. Raw HTML is shown as text, links must be http(s), and images are never loaded
// (the extension makes no network calls except to YouTube and the Claude API).
import katex from 'katex';
import { Marked, type Tokens } from 'marked';
import { splitCode } from './export';
import { findTimestamps, type FoundTimestamp } from './time';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface RenderOptions {
  /** Returns highlighted HTML for a known language, or null. */
  highlight?: (code: string, lang: string) => string | null;
  /** 'mathml' needs no fonts or CSS (used inside YouTube's page). */
  mathOutput?: 'htmlAndMathml' | 'mathml';
  /** Adds a "Run" button to JavaScript and Python blocks. */
  runnable?: (lang: string) => boolean;
}

interface MathPiece {
  tex: string;
  display: boolean;
}

const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?=[^\s$])((?:\\.|[^$\\\n])+?)(?<=[^\s\\])\$(?!\d)/g;

function protect(text: string, math: MathPiece[], stamps: FoundTimestamp[]): string {
  const out = text.replace(MATH_RE, (_whole, dd: string | undefined, br: string | undefined, pa: string | undefined, d: string | undefined) => {
    const display = dd !== undefined || br !== undefined;
    math.push({ tex: (dd ?? br ?? pa ?? d ?? '').trim(), display });
    const ph = `\uE000${math.length - 1}\uE001`;
    return display ? `\n\n${ph}\n\n` : ph;
  });
  let res = '';
  let pos = 0;
  for (const ts of findTimestamps(out)) {
    stamps.push(ts);
    res += out.slice(pos, ts.index) + `\uE002${stamps.length - 1}\uE003`;
    pos = ts.index + ts.length;
  }
  return res + out.slice(pos);
}

export function createRenderer(opts: RenderOptions = {}): (md: string) => string {
  const marked = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      html(token: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(token.text);
      },
      code(token: Tokens.Code) {
        const lang = (token.lang ?? '').trim().split(/\s+/)[0].toLowerCase();
        const body = (lang && opts.highlight?.(token.text, lang)) || escapeHtml(token.text);
        const run = opts.runnable?.(lang) ? `<button type="button" class="copy" data-action="run" data-lang="${escapeHtml(lang)}">Run</button>` : '';
        return `<div class="code"><div class="code-head"><span>${escapeHtml(lang || 'text')}</span><span>${run}<button type="button" class="copy" data-action="copy">Copy</button></span></div><pre><code class="hljs">${body}</code></pre><div class="run-out" hidden></div></div>`;
      },
      link(this: { parser: { parseInline: (t: Tokens.Generic[]) => string } }, token: Tokens.Link) {
        const text = this.parser.parseInline(token.tokens);
        if (!/^https?:\/\//i.test(token.href)) return text;
        return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      },
      image(token: Tokens.Image) {
        return token.text ? `<span class="img-alt">[image: ${escapeHtml(token.text)}]</span>` : '';
      },
    },
  });
  const renderMath = (m: MathPiece) => {
    try {
      return katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false, strict: 'ignore', trust: false, output: opts.mathOutput ?? 'htmlAndMathml' });
    } catch {
      return `<code>${escapeHtml(m.tex)}</code>`;
    }
  };
  const renderStamp = (ts: FoundTimestamp) => `<button type="button" class="ts" data-t="${ts.start}" title="Jump to ${escapeHtml(ts.label)}">${escapeHtml(ts.label)}</button>`;
  return (md: string) => {
    const math: MathPiece[] = [];
    const stamps: FoundTimestamp[] = [];
    const prepared = splitCode(md)
      .map((seg) => (seg.code ? seg.text : protect(seg.text, math, stamps)))
      .join('');
    const html = marked.parse(prepared, { async: false }) as string;
    return html.replace(/\uE000(\d+)\uE001/g, (_, i: string) => renderMath(math[Number(i)])).replace(/\uE002(\d+)\uE003/g, (_, i: string) => renderStamp(stamps[Number(i)]));
  };
}
