// chrome.storage helpers: settings, learner profile, session usage. Learning data is in IndexedDB
// (db.ts, records.ts). The API key is read only by the service worker.
import { EMPTY_USAGE, KEYS, normalizeSettings, type Settings, type UsageTotals } from './settings';
import type { LearnerProfile } from './types';

export async function getSettings(): Promise<Settings> {
  return normalizeSettings((await chrome.storage.local.get(KEYS.settings))[KEYS.settings]);
}
export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEYS.settings]: s });
}

export const EMPTY_PROFILE: LearnerProfile = { background: '', goals: '', style: '' };
export async function getProfile(): Promise<LearnerProfile> {
  const p = (await chrome.storage.local.get(KEYS.profile))[KEYS.profile] as Partial<LearnerProfile> | undefined;
  return { ...EMPTY_PROFILE, ...(p ?? {}) };
}
export async function saveProfile(p: LearnerProfile): Promise<void> {
  await chrome.storage.local.set({ [KEYS.profile]: p });
}

export async function getUsage(): Promise<UsageTotals> {
  return ((await chrome.storage.session.get(KEYS.usage))[KEYS.usage] as UsageTotals | undefined) ?? EMPTY_USAGE;
}
/** Usage increments run one at a time: two requests finishing together would otherwise both read
 *  the same totals and the later write would drop the other's tokens and cost. */
let usageQueue: Promise<void> = Promise.resolve();
export function addUsage(u: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }): Promise<void> {
  usageQueue = usageQueue
    .then(async () => {
      const cur = await getUsage();
      await chrome.storage.session.set({
        [KEYS.usage]: {
          requests: cur.requests + 1,
          inputTokens: cur.inputTokens + u.input,
          outputTokens: cur.outputTokens + u.output,
          cacheReadTokens: cur.cacheReadTokens + u.cacheRead,
          cacheWriteTokens: cur.cacheWriteTokens + u.cacheWrite,
          costUsd: cur.costUsd + u.costUsd,
        } satisfies UsageTotals,
      });
    })
    .catch(() => undefined);
  return usageQueue;
}
