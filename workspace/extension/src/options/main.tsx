// Settings page: API key, model, behaviour, what is sent, session cost, stored data.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import '../panel/styles.css';
import './options.css';
import * as db from '../shared/db';
import { ensureMigrated } from '../shared/migrate';
import { notifyChanged } from '../shared/records';
import { sendToBackground } from '../shared/rpc';
import { DEFAULT_SETTINGS, EMPTY_USAGE, KEYS, MODELS, type Settings, type UsageTotals } from '../shared/settings';
import * as store from '../shared/store';
import type { LearnerProfile } from '../shared/types';

function Options() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [key, setKey] = useState('');
  const [keyInfo, setKeyInfo] = useState<{ hasKey: boolean; hint: string }>({ hasKey: false, hint: '' });
  const [saved, setSaved] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageTotals>(EMPTY_USAGE);
  const [videos, setVideos] = useState<{ videoId: string; title: string; updatedAt: number }[]>([]);
  const [shortcuts, setShortcuts] = useState<chrome.commands.Command[]>([]);
  const [profile, setProfile] = useState<LearnerProfile>(store.EMPTY_PROFILE);
  const [mic, setMic] = useState<string | null>(null);
  /** The service worker did not answer (not running, or still the old build after a reload). */
  const [workerDown, setWorkerDown] = useState(false);

  const loadKeyInfo = async () => {
    const r = await sendToBackground({ type: 'bg/has-key' }).catch(() => undefined);
    setWorkerDown(!r);
    setKeyInfo(r ?? { hasKey: false, hint: '' });
  };

  const refresh = async () => {
    setSettings(await store.getSettings());
    await loadKeyInfo();
    setUsage(await store.getUsage());
    setProfile(await store.getProfile());
    await ensureMigrated().catch(() => undefined);
    setVideos((await db.getAll('videos')).sort((a, b) => b.updatedAt - a.updatedAt));
  };
  useEffect(() => {
    refresh();
    chrome.commands.getAll().then(setShortcuts).catch(() => undefined);
  }, []);

  const flash = (msg: string) => {
    setSaved(msg);
    setTimeout(() => setSaved(null), 2200);
  };
  const update = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await store.saveSettings(next);
    flash('Saved');
  };
  const saveKey = async () => {
    const k = key.trim();
    if (!k) return;
    if (!/^sk-ant-/.test(k) && !confirm('This does not look like an Anthropic API key (they start with "sk-ant-"). Save it anyway?')) return;
    // Written here, read only by the service worker.
    await chrome.storage.local.set({ [KEYS.apiKey]: k });
    setKey('');
    await loadKeyInfo();
    flash('API key saved');
  };
  const removeKey = async () => {
    await chrome.storage.local.remove(KEYS.apiKey);
    setKeyInfo({ hasKey: false, hint: '' });
    flash('API key removed');
  };

  return (
    <main class="opt">
      <h1>YouTube Tutor</h1>
      <p class="muted">A side-panel tutor for YouTube lectures. Settings are stored in this browser only.</p>
      {workerDown && (
        <section class="card" role="alert">
          <strong>The extension's background worker did not answer.</strong>
          <p class="small">
            Open chrome://extensions, click the reload arrow on YouTube Tutor, then reload this page. Until then the key status below may be wrong and the tutor will not answer.
          </p>
        </section>
      )}

      <section class="card">
        <h2>Anthropic API key</h2>
        <p class="small muted">
          Bring your own key from the Claude Console. It is stored in <code>chrome.storage.local</code> on this device, readable only by the extension's own pages (not by its scripts inside the YouTube page), and used only by the extension's service worker to call
          the Claude API directly. It is never sent anywhere else and never shown to YouTube.
        </p>
        {keyInfo.hasKey ? (
          <div class="row">
            <span class="pill solid">Key saved {keyInfo.hint}</span>
            <button type="button" class="btn ghost small" onClick={removeKey}>
              Remove
            </button>
          </div>
        ) : (
          <span class="pill amber">No key yet</span>
        )}
        <div class="row" style={{ marginTop: 10, flexWrap: 'nowrap' }}>
          <input type="password" autocomplete="off" spellcheck={false} placeholder={keyInfo.hasKey ? 'Replace with a new key' : 'sk-ant-…'} value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && saveKey()} />
          <button type="button" class="btn primary" disabled={!key.trim()} onClick={saveKey}>
            Save key
          </button>
        </div>
      </section>

      <section class="card">
        <h2>About you</h2>
        <p class="small muted">Sent with every request so the tutor can pitch explanations to you. Optional.</p>
        {(
          [
            ['background', 'Background', 'e.g. second-year CS student, comfortable with Python, weak on linear algebra'],
            ['goals', 'Goals', 'e.g. understand transformers well enough to implement one'],
            ['style', 'Preferred explanation style', 'e.g. intuition and a small example first; skip the history'],
          ] as const
        ).map(([k, label, ph]) => (
          <label class="field" key={k} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
            <span>{label}</span>
            <textarea
              rows={2}
              placeholder={ph}
              value={profile[k]}
              onInput={(e) => setProfile({ ...profile, [k]: (e.target as HTMLTextAreaElement).value })}
              onBlur={async () => {
                await store.saveProfile(profile);
                flash('Saved');
              }}
              style={{ border: '1px solid var(--line-strong)', borderRadius: 8, background: 'var(--bg)', padding: '7px 10px', resize: 'vertical' }}
            />
          </label>
        ))}
      </section>

      <section class="card">
        <h2>Model</h2>
        <div class="choices">
          {MODELS.map((m) => (
            <label key={m.id} class="choice">
              <input type="radio" name="model" checked={settings.model === m.id} onChange={() => update({ model: m.id })} />
              <span>
                <strong>{m.label}</strong> <span class="muted small">· {m.note} · ${m.inPerM}/${m.outPerM} per million input/output tokens</span>
              </span>
            </label>
          ))}
        </div>
        <label class="field">
          <span>Effort</span>
          <select value={settings.effort} onChange={(e) => update({ effort: (e.target as HTMLSelectElement).value as Settings['effort'] })}>
            <option value="low">Low: fastest, cheapest</option>
            <option value="medium">Medium (default)</option>
            <option value="high">High: more thorough, slower</option>
          </select>
        </label>
      </section>

      <section class="card">
        <h2>Tutor behaviour</h2>
        <label class="check">
          <input type="checkbox" checked={settings.prepareLessonAutomatically} onChange={(e) => update({ prepareLessonAutomatically: (e.target as HTMLInputElement).checked })} />
          <span>
            <strong>Prepare the lesson automatically</strong>
            <span class="small muted block">When the panel is open on a video with captions, make one call over the full transcript to build the lesson map (sections, concepts, checkpoints). Off: use the "Prepare lesson" button.</span>
          </span>
        </label>
        <label class="field">
          <span>Checkpoints</span>
          <select value={settings.checkpointMode} onChange={(e) => update({ checkpointMode: (e.target as HTMLSelectElement).value as Settings['checkpointMode'] })}>
            <option value="off">Off: never</option>
            <option value="gentle">Gentle: a card appears, the video keeps playing</option>
            <option value="active">Active: the video pauses until you answer or skip</option>
          </select>
        </label>
        <label class="check">
          <input type="checkbox" checked={settings.hintsFirst} onChange={(e) => update({ hintsFirst: (e.target as HTMLInputElement).checked })} />
          <span>
            <strong>Hints before answers</strong>
            <span class="small muted block">For questions that look like exercises, the tutor gives a hint and asks you to try first.</span>
          </span>
        </label>
        <label class="check">
          <input type="checkbox" checked={settings.frameBuffer} onChange={(e) => update({ frameBuffer: (e.target as HTMLInputElement).checked })} />
          <span>
            <strong>Keep a rolling buffer of frames</strong>
            <span class="small muted block">While you watch with the panel open, keep one frame every ~15 s (duplicates dropped, last 40 per video) so you can ask about an earlier screen and see thumbnails. Stored only in this browser.</span>
          </span>
        </label>
        <label class="check">
          <input type="checkbox" checked={settings.smartSpeed} onChange={(e) => update({ smartSpeed: (e.target as HTMLInputElement).checked })} />
          <span>
            <strong>Smart speed</strong> <span class="pill">off by default</span>
            <span class="small muted block">Changes the playback rate per section: slower for shaky or dense sections, faster for sections you marked as known. Turning it off restores your own rate.</span>
          </span>
        </label>
        <label class="check">
          <input type="checkbox" checked={settings.voiceInput} onChange={(e) => update({ voiceInput: (e.target as HTMLInputElement).checked })} />
          <span>
            <strong>Voice input</strong> <span class="pill">off by default</span>
            <span class="small muted block">
              Hold the microphone button (or Alt+V in the question box) to dictate. This uses the browser's speech recognition, which may send your audio to the browser vendor (Google, in Chrome) to transcribe it. The extension itself never records or sends audio.
            </span>
          </span>
        </label>
        {settings.voiceInput && (
          <div class="row" style={{ marginLeft: 28 }}>
            <button
              type="button"
              class="btn small"
              onClick={async () => {
                try {
                  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
                  s.getTracks().forEach((t) => t.stop());
                  setMic('Microphone allowed for the extension.');
                } catch (e) {
                  setMic(`Not allowed: ${String(e)}`);
                }
              }}
            >
              Allow microphone
            </button>
            <span class="small muted">{mic ?? 'Chrome asks once here; the side panel cannot show the prompt itself.'}</span>
          </div>
        )}
        <label class="field">
          <span>Full transcript for videos up to</span>
          <select value={String(settings.fullTranscriptMinutes)} onChange={(e) => update({ fullTranscriptMinutes: Number((e.target as HTMLSelectElement).value) })}>
            {[30, 60, 90, 120, 180, 300].map((m) => (
              <option key={m} value={String(m)}>
                {m} minutes
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          <span>Earlier questions sent as context</span>
          <select value={String(settings.historyTurns)} onChange={(e) => update({ historyTurns: Number((e.target as HTMLSelectElement).value) })}>
            {[0, 4, 10, 20].map((n) => (
              <option key={n} value={String(n)}>
                {n === 0 ? 'None' : `Last ${n}`}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section class="card">
        <h2>What is sent to the Claude API</h2>
        <p class="small">Nothing is sent until you ask a question, press a tutor button, or open the panel with "Prepare the lesson automatically" on. Each request goes from this browser straight to api.anthropic.com and contains:</p>
        <ul class="small">
          <li>the video's title, channel, chapter titles and caption transcript (the full transcript for videos up to the length above; otherwise the captions around the current moment and the lesson map);</li>
          <li>an image of the current video frame, and a crop of it if you select a region (you can remove the frame before asking);</li>
          <li>your question, your earlier questions and answers for this video, checkpoint and practice answers (with your code's test results), explanations and summaries you write, and which concepts you found shaky or solid;</li>
          <li>the "About you" text above, and the names and links of earlier videos in your library that taught the same concepts;</li>
          <li>when a question refers to an earlier screen, up to three earlier frames from the local buffer.</li>
        </ul>
        <p class="small muted">Code you run in the sandbox stays in this browser: the sandbox has no network access and no access to extension storage; Python runs on Pyodide shipped inside the extension.</p>
        <p class="small muted">The extension runs only on youtube.com. It cannot read your other tabs or sites, and it never injects into or screenshots a tab that is not YouTube. Frames are buffered only while the panel is open on the video and the tab is in front.</p>
        <p class="small muted">No analytics, no other servers. Learning data (questions, answers, lesson maps, frames, bookmarks, practice, review cards) stays in this browser's IndexedDB. The only other outside service is the browser's own speech recognition, and only if you turn on voice input.</p>
      </section>

      <section class="card">
        <h2>This session's usage</h2>
        <p class="small">
          {usage.requests} requests · {usage.inputTokens.toLocaleString()} input, {usage.cacheReadTokens.toLocaleString()} cache-read, {usage.cacheWriteTokens.toLocaleString()} cache-write, {usage.outputTokens.toLocaleString()} output tokens ·{' '}
          <strong>≈ ${usage.costUsd.toFixed(3)}</strong>
        </p>
        <p class="small muted">An estimate at list prices since the browser started. Your Claude Console shows the exact bill.</p>
      </section>

      <section class="card">
        <h2>Keyboard shortcuts</h2>
        <ul class="small">
          {shortcuts
            .filter((c) => c.name && !c.name.startsWith('_'))
            .map((c) => (
              <li key={c.name}>
                <span class="kbd">{c.shortcut || 'not set'}</span> {c.description}
              </li>
            ))}
          <li>
            <span class="kbd">/</span> in the panel focuses the question box; <span class="kbd">Enter</span> sends, <span class="kbd">Shift</span>+<span class="kbd">Enter</span> adds a line.
          </li>
        </ul>
        <p class="small muted">Change them at chrome://extensions/shortcuts.</p>
      </section>

      <section class="card">
        <h2>Stored data</h2>
        <p class="small">
          {videos.length ? `Learning data for ${videos.length} video${videos.length === 1 ? '' : 's'}.` : 'No learning data stored yet.'}{' '}
          <a href="../library/index.html">Open the library</a>
        </p>
        {videos.length > 0 && (
          <ul class="small">
            {videos.slice(0, 12).map((v) => (
              <li key={v.videoId}>{v.title || v.videoId}</li>
            ))}
          </ul>
        )}
        <button
          type="button"
          class="btn"
          disabled={!videos.length}
          onClick={async () => {
            if (!confirm('Delete all questions, answers, lesson maps, frames, bookmarks, practice, review cards and progress for every video? Your API key, profile and settings are kept. This cannot be undone.')) return;
            await db.clearAllData();
            notifyChanged(null, ['video', 'cards']);
            await refresh();
            flash('All learning data cleared');
          }}
        >
          Clear all learning data
        </button>
      </section>
      {saved && (
        <div class="toast" role="status">
          {saved}
        </div>
      )}
    </main>
  );
}

render(<Options />, document.getElementById('app')!);
