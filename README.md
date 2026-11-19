# YouTube Tutor

A Chrome extension that sits in the side panel next to a YouTube video and tutors you through it. It reads the video's captions with timestamps and the frame that is on screen right now, and sends your question with both to Claude, which answers with links back into the video, rendered math and highlighted code. It is aimed at technical lectures (machine learning, programming, mathematics, logic), where the important content is on screen while the speaker says "this term here".

It is a personal tool, installed from source with "Load unpacked". There is no Web Store listing and no backend: you bring your own Anthropic API key.

## What it does

- **Ask about this moment.** Pause, or press a shortcut, and ask. The tutor sees the captions from about 90 seconds before to 15 seconds after the current time, the current frame, and the whole transcript for videos up to about an hour (long videos get a lesson map instead). Context chips show exactly what will be sent; you can remove the frame or captions, or re-capture.
- **Point at it.** Click the frame thumbnail and drag a box around a term, a line of code or part of a diagram. The crop is sent at full resolution next to the frame.
- **I'm lost.** One button or shortcut, no typing: the tutor works out the likely sticking point in the last 90 seconds, explains it, and offers two other guesses you can click.
- **Explain this screen, Walk me through it, Extract code / LaTeX.** One click each.
- **Depth on demand.** Every answer has Simpler, Example and Formal buttons.
- **Lesson map.** One call over the transcript produces sections, key ideas, concepts with where they are defined, prerequisites, suggested questions and checkpoints. The Watch view shows the current section, a timeline, and question chips.
- **Checkpoints** (Off / Gentle / Active): short questions at natural pauses (predict the output, next step of the derivation, find the bug, is this argument valid). Free-text answers are graded with what was right, what was missing, and the moment to rewatch.
- **Explain it back.** Write a section in your own words and get a critique of the gaps.
- **Learner model.** Each concept is unseen, seen, shaky or solid. "I'm lost", "Simpler" and missed checkpoints mark concepts shaky; correct checkpoints and good explanations mark them solid. The tutor is told which is which.
- **Review.** Key ideas, shaky concepts with links, checkpoint results, a final quiz weighted towards what you found hard, and export of notes (Markdown) and flashcards (Anki CSV).
- **Skip what you know, plan by goal.** Mark sections as known to grey them and jump past; or say what you want from the video and get the parts to watch, in order.
- **Where was I.** Reopen a video and get a three-line recap and a resume button.

Second build (plan §13):

- **Before watching:** a learner profile (background, goals, preferred style) sent with every request; three pre-questions to guess at, revisited in Review; a quick prerequisite check with a two-minute primer for each gap, or a link to the earlier video in your library that taught it.
- **While watching:** a rolling buffer of frames (one every ~15 s, near-duplicates dropped by perceptual hash, last 40 kept) so "that formula two slides ago" attaches the right earlier screen; thumbnails on the timeline strip and in the transcript; bookmarks (time, frame, caption line, note) on a hotkey; a quiet "Want help with this part?" when you rewind the same stretch twice or pause long on a dense screen; optional smart speed per section; a running notation and glossary table; an **Ask** button in the player controls and a small overlay over the video that works in fullscreen; optional voice input.
- **Practice:** new problems on a concept with worked-example fading (study one, finish one, solve one), a hint ladder (nudge, which idea, first step, full solution), a code sandbox that runs JavaScript and Python (Pyodide, bundled) with tests, a confidence rating before grading, and a mistake log.
- **After watching:** a Feynman summary graded against the lesson map, a one-page cheat sheet, notes exported as a zip of Markdown plus images (opens in Obsidian), and spaced review: shaky concepts, missed checkpoints and mistakes become cards on an SM-2-style schedule, mixed across videos, with the number due on the toolbar icon.
- **Across videos:** a library page with progress, time spent, search across all notes, questions, bookmarks, mistakes and transcripts, a concept graph coloured by state (click a concept to see where it was taught and practise it), playlist awareness ("previously in this course", concepts carried forward), and answers that link back to the earlier video where a concept was first met.

## Install

You need Chrome 116 or newer, Node.js 20 or newer, and an Anthropic API key from the [Claude Console](https://console.anthropic.com/).

```sh
git clone <this repository>
cd youtube-tutor/workspace/extension
npm install
npm run build
```

`npm run build` type-checks, builds into `workspace/extension/dist/`, and checks the result (valid Manifest V3, every referenced file present, the code sandbox isolated, Pyodide bundled, no secrets). The build copies Pyodide (about 13.5 MB, MPL-2.0) from `node_modules`, so `dist/` is about 16 MB.

Then load it:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose `workspace/extension/dist`.
4. Pin "YouTube Tutor" from the puzzle-piece menu so its icon is on the toolbar.

After pulling new code, run `npm run build` again and click the reload arrow on the extension's card in `chrome://extensions`. Reload any open YouTube tabs too (the panel will also try to reconnect to an existing tab by itself).

## Set your API key

Click the extension icon to open the side panel, then the gear icon (or right-click the icon and choose **Options**). Paste your key (it starts with `sk-ant-`) and click **Save key**. On the same page you can fill in "About you", choose the model, effort, checkpoint mode and other behaviour (smart speed and voice input are off by default), and see this session's token usage and estimated cost.

The key is stored in `chrome.storage.local` in this browser profile and is read only by the extension's service worker, which calls `https://api.anthropic.com` directly. It is never put in the repository, never sent anywhere else, and never exposed to the YouTube page.

Models: **Claude Sonnet 5.5** (default, fast), **Claude Opus 5.5** (stronger reasoning) and **Claude Fable 5.2** (most capable, slowest and most expensive). The transcript is sent in a cached prefix, so follow-up questions on the same video cost much less than the first.

## Use it

1. Open a lecture on `youtube.com/watch`.
2. Click the toolbar icon. The panel loads the captions and, if "Prepare the lesson automatically" is on, builds the lesson map.
3. Watch. Pause, or press a shortcut, to ask.

The panel has five tabs: **Watch** (before-you-watch questions, current section, timeline and frames, checkpoints, glossary, bookmarks), **Ask** (the conversation and the context chips), **Practice** (problem sets with hints and the code sandbox), **Review** (summary, Feynman summary, cheat sheet, calibration, mistake log, quiz, export) and **Transcript** (searchable, with thumbnails). It switches between Watch and Ask as you play and pause, and to Review when the video ends. The badge in the header opens the review queue, which also works on any non-YouTube page; the shelf icon opens the **library** in a tab.

### Shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Shift+A` (Option+Shift+A on macOS) | Pause, open the panel and focus the question box |
| `Alt+Shift+L` | I'm lost: pause and explain the last 90 seconds |
| `Alt+Shift+E` | Explain what is on screen now |
| `Alt+Shift+B` | Bookmark this moment (no panel needed) |
| `Alt+V` (hold, in the question box) | Dictate, if voice input is on |
| `/` (in the panel) | Focus the question box |
| `Enter` / `Shift+Enter` | Send / new line |

Change the global shortcuts at `chrome://extensions/shortcuts`. Using a shortcut or clicking the toolbar icon also gives the extension a one-time permission to screenshot the tab, which the frame fallback needs (see below).

## Privacy: what it can see, and when

- **Only YouTube.** The extension's scripts run on `www.youtube.com` pages and nowhere else. It has no permission to read other sites, your history or your other tabs, and the service worker refuses to inject into or screenshot a tab that is not YouTube. When you switch to another tab, the side panel only learns that the front tab is "not a YouTube page".
- **Only while you use it.** On a YouTube page the extension reads the video's title, captions and playback position. Until you open the panel on a video, none of that is saved to disk or sent anywhere; the video's title and caption list are held in memory until the browser closes.
- **Frames.** A frame is captured when you ask, bookmark, or (if the frame buffer is on) every ~15 s while the panel is open on that video and the tab is in front. The buffer stops within a minute of closing the panel and immediately when the tab goes to the background. Frames come from the video itself. The screenshot fallback for protected video runs only while the YouTube tab is in front and is cropped to the player.
- **What is stored.** Videos you study, with your questions, answers, frames, bookmarks, practice and progress, are kept in this browser profile only, unencrypted like any browser data. Clear one video from the Review tab or everything from Settings; removing the extension deletes it all.
- **The API key** is stored in `chrome.storage.local`, readable only by the extension's own pages and service worker (not by its scripts inside the YouTube page), and sent only to `api.anthropic.com`.
- **Locked-down pages.** The extension's pages can load nothing from the network except the Claude API: no remote images, fonts, scripts or frames. Answers are rendered with raw HTML escaped and images disabled, so text in a video's captions cannot make the panel fetch a tracking URL.
- **Anthropic's side.** What you send is handled under the terms of your own Anthropic API account, including its data-retention settings.

## What is sent, and where

Nothing is sent until you ask a question, press a tutor button, or open the panel on a video with "Prepare the lesson automatically" turned on. Each request goes from your browser straight to `api.anthropic.com` and contains:

- the video's title, channel, chapter titles and caption transcript (the full transcript for videos up to the length set in Settings, default 60 minutes; otherwise the captions around the current moment plus the lesson map);
- an image of the current frame, and a crop of it if you selected a region (you can remove the frame before asking);
- your question, your earlier questions and answers on this video (the last 10 by default), checkpoint answers and explanations you write, and which concepts you found shaky or solid.

The request may also include your "About you" profile, the titles and links of earlier videos in your library that taught the same concepts, up to three earlier frames from the local buffer when a question refers back, your practice answers with your code's test results, and your Feynman summary.

The extension makes no other network calls: no analytics, no telemetry, no other servers. It reads only what YouTube has already loaded in the page and never downloads video. Your learning data (questions, answers, lesson maps, frames, bookmarks, practice, review cards, progress) is stored in the extension's IndexedDB in this browser and can be cleared per video (Review tab) or entirely (Settings). Data from the first build is migrated into IndexedDB automatically the first time the new version runs.

Two things happen locally rather than over the network: code you run goes to a sandboxed extension page with no network access and no access to extension storage (Python runs on the Pyodide copy shipped inside the extension), and frames for the buffer are captured from the video in the page. The one optional exception is voice input: Chrome's speech recognition may send your audio to Google to transcribe it, which is why it is off by default.

### Permissions

| Permission | Why |
|---|---|
| `sidePanel` | The tutor lives in the side panel |
| `storage` | Settings, your API key, the profile, the session's usage |
| `scripting` | Re-attach to YouTube tabs opened before install, and inject the fullscreen overlay on demand |
| `activeTab` | The screenshot fallback for protected video, granted when you click the icon or use a shortcut |
| `unlimitedStorage` | Frames and transcripts in IndexedDB would otherwise hit the default quota |
| `alarms` | Refresh the "cards due" badge every 30 minutes |
| `https://www.youtube.com/*` | Read captions and frames on watch pages |
| `https://api.anthropic.com/*` | Call Claude |

## How it gets captions and frames

Captions, in order of preference:

1. **The player's own request.** A small script in the page observes the player's `/api/timedtext` responses. If captions are off, it switches them on briefly through the player API so the player fetches them, then restores your setting. This is the main path: direct fetches of the caption URL now return an empty body without a token that only the player has.
2. **Direct fetch** of the caption track (cheap to try; usually empty).
3. **The "Show transcript" panel,** opened, read and closed again.
4. **No captions:** the panel says so and the tutor answers from the frame alone.

It prefers manual captions in the video's spoken language, then the automatic ones, and never uses YouTube's auto-translation; Claude answers in the language of your question either way. Captions are cached per video for the browser session.

Frames are drawn from the `<video>` element at native resolution (long edge capped at 1568 px). If that comes back black (protected content) it falls back to a screenshot of the tab cropped to the video, which needs the one-time permission mentioned above. A nearly uniform frame is never sent; the panel says so. Below 720p you get a warning that small text may be unreadable.

## Limitations

- Desktop Chrome, `youtube.com/watch` pages only. No Shorts, live streams or embedded players.
- Videos without any captions get frame-only answers.
- While an ad plays, the tutor waits for it to finish before loading captions and will not capture frames.
- The side panel is not visible in fullscreen; use the in-player Ask button or the shortcuts, which open a small overlay over the video instead.
- Questions about an earlier screen use the frame buffer, which only covers time you watched with the panel open (and only one frame every ~15 s).
- Python in the sandbox is the standard library only (no NumPy or other packages), and the first run takes a few seconds while Pyodide starts.
- YouTube changes its page often. Everything YouTube-specific (selectors, player-response parsing, caption formats) is in `workspace/extension/src/shared/youtube.ts` and `src/shared/captions.ts`, so that is where fixes go.

## Development

```sh
cd workspace/extension
npm test            # unit tests (Vitest)
npm run typecheck
npm run build       # typecheck + build + dist check
```

Layout of `workspace/extension/src`:

| Folder | What runs there |
|---|---|
| `page/` | Main-world script: observes caption responses, reads the player response, chapters and playlist, toggles captions |
| `content/` | Content script: navigation, caption fallback chain, frame capture and sampling, seek and pause signals, bookmarks, the in-player Ask button |
| `overlay/` | Overlay over the player (injected on demand; works in fullscreen) |
| `background/` | Service worker: API key, prompt assembly, Claude client (streaming over a long-lived port), frames and bookmarks, review badge, shortcuts, migration |
| `panel/` | Side panel UI (Preact): `state/` (controller hooks), `views/` (Watch, Ask, Practice, Review, Transcript, review queue), Markdown/KaTeX/highlight rendering, sandbox client |
| `library/` | Library page: videos, search, concept graph, mistakes, review |
| `sandbox/` | Code runner for the sandboxed page (JavaScript and Pyodide in workers) |
| `options/` | Settings page |
| `shared/` | Typed messages, YouTube module, captions, context, prompts, IndexedDB store and migration, learner model, scheduler, frames, signals, practice, library logic, zip and notes export |

Pure logic (caption parsing and merging, context selection, timestamp handling, prompt building, learner-model transitions, the review scheduler, perceptual hashing and frame pruning, confusion signals, the hint ladder and calibration, playlist carry-over, library search, export and zip assembly, and the first-build migration) lives in plain functions under `src/shared/` with tests in `tests/`. One test runs the Python test harness under the real Pyodide package. The YouTube tests use small fixtures trimmed from real watch pages; if you fetch full watch pages into `workspace/scratch/pages/`, extra tests run against them.

The build is a set of plain Vite builds (`scripts/build.mjs`): the extension pages (panel, settings, library), the service worker as one ES module, the content, page and overlay scripts and the sandbox runner as self-contained classic scripts; then Pyodide is copied from `node_modules`.

## Licence

Not decided yet; there is no LICENSE file for now.
