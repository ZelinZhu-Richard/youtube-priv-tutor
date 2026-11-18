// Panel side of the long-lived "tutor" port. Reconnects after the service worker restarts and
// pings while requests are in flight so the worker is not suspended mid-stream.
import { TUTOR_PORT, type DoneResult, type PortEvent, type PortRequest, type TutorError, type UsageReport } from '../shared/messages';

export interface Handlers {
  onStart?: (model: string) => void;
  onThinking?: (text: string) => void;
  onDelta?: (text: string) => void;
  onDone: (result: DoneResult, info: { usage: UsageReport | null; servedBy: string; truncated: boolean }) => void;
  onError: (error: TutorError) => void;
}

export class TutorPort {
  private port: chrome.runtime.Port | null = null;
  private handlers = new Map<string, Handlers>();
  private timer: ReturnType<typeof setInterval> | null = null;

  private ensure(): chrome.runtime.Port {
    if (this.port) return this.port;
    const port = chrome.runtime.connect({ name: TUTOR_PORT });
    port.onMessage.addListener((e: PortEvent) => this.onEvent(e));
    port.onDisconnect.addListener(() => {
      this.port = null;
      const lost = [...this.handlers.values()];
      this.handlers.clear();
      this.updateTimer();
      for (const h of lost) h.onError({ code: 'network', message: 'Lost the connection to the extension. Try again.', retryable: true });
    });
    this.port = port;
    return port;
  }

  private onEvent(e: PortEvent) {
    if (e.type === 'pong') return;
    const h = this.handlers.get(e.reqId);
    if (!h) return;
    switch (e.type) {
      case 'started':
        h.onStart?.(e.model);
        break;
      case 'thinking':
        h.onThinking?.(e.text);
        break;
      case 'delta':
        h.onDelta?.(e.text);
        break;
      case 'done':
        this.handlers.delete(e.reqId);
        this.updateTimer();
        h.onDone(e.result, { usage: e.usage, servedBy: e.servedBy, truncated: e.truncated });
        break;
      case 'error':
        this.handlers.delete(e.reqId);
        this.updateTimer();
        h.onError(e.error);
        break;
    }
  }

  private updateTimer() {
    if (this.handlers.size && !this.timer) {
      this.timer = setInterval(() => this.port?.postMessage({ type: 'ping' } satisfies PortRequest), 20_000);
    } else if (!this.handlers.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  request(req: Exclude<PortRequest, { type: 'ping' } | { type: 'cancel' }>, h: Handlers) {
    this.handlers.set(req.reqId, h);
    this.updateTimer();
    try {
      this.ensure().postMessage(req);
    } catch {
      this.port = null;
      this.ensure().postMessage(req);
    }
  }

  cancel(reqId: string) {
    this.port?.postMessage({ type: 'cancel', reqId } satisfies PortRequest);
  }

  busy(): boolean {
    return this.handlers.size > 0;
  }
}
