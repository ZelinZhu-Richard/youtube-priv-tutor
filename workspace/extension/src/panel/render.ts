// Side-panel answer rendering: the shared Markdown/KaTeX core plus highlight.js and Run buttons.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import haskell from 'highlight.js/lib/languages/haskell';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import julia from 'highlight.js/lib/languages/julia';
import latex from 'highlight.js/lib/languages/latex';
import matlab from 'highlight.js/lib/languages/matlab';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import { createRenderer } from '../shared/markdown';
export { escapeHtml } from '../shared/markdown';

const LANGS = { bash, c, cpp, csharp, go, haskell, java, javascript, json, julia, latex, matlab, plaintext, python, r, rust, sql, typescript };
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['py', 'python3', 'ipython'], { languageName: 'python' });
hljs.registerAliases(['js', 'jsx', 'mjs'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['c++', 'cc', 'cuda'], { languageName: 'cpp' });
hljs.registerAliases(['tex'], { languageName: 'latex' });
hljs.registerAliases(['text', 'txt', 'output'], { languageName: 'plaintext' });


/** Markdown with math, code and timestamps to safe HTML. */
export const renderMarkdown = createRenderer({
  highlight: (code, lang) => (hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : null),
  runnable: (lang) => ['js', 'javascript', 'py', 'python', 'python3'].includes(lang),
});
