// Small typed wrappers around chrome messaging.
import type { BackgroundResponses, ContentResponses, ToBackground, ToContent } from './messages';

export async function sendToContent<M extends ToContent>(tabId: number, msg: M): Promise<ContentResponses[M['type']]> {
  return (await chrome.tabs.sendMessage(tabId, msg)) as ContentResponses[M['type']];
}

export async function sendToBackground<M extends ToBackground>(msg: M): Promise<BackgroundResponses[M['type']]> {
  return (await chrome.runtime.sendMessage(msg)) as BackgroundResponses[M['type']];
}

/** Fire-and-forget broadcast that ignores "no receiver" errors (e.g. the panel is closed). */
export function broadcast(msg: unknown): void {
  try {
    chrome.runtime.sendMessage(msg).catch(() => undefined);
  } catch {
    /* extension context invalidated (extension reloaded): ignore */
  }
}

export function uid(prefix = ''): string {
  const r = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}${Date.now().toString(36)}${r[0].toString(36)}${r[1].toString(36)}`;
}
