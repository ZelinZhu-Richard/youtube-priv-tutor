// Who the service worker will listen to: this extension's own pages (side panel, Settings,
// Library — the last two open in a tab, so sender.tab is set for them too) and its content
// scripts on YouTube. Judged by the sending frame's URL; a tab's URL is only a fallback.

export interface SenderLike {
  id?: string;
  url?: string;
  tab?: { url?: string };
}

export const YOUTUBE_URL = /^https:\/\/www\.youtube\.com\//;

export function isTrustedSender(sender: SenderLike | undefined, extensionId: string): boolean {
  if (!sender || !extensionId || sender.id !== extensionId) return false;
  const from = sender.url ?? sender.tab?.url ?? '';
  return from.startsWith(`chrome-extension://${extensionId}/`) || YOUTUBE_URL.test(from);
}
