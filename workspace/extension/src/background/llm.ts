// Claude API client for the service worker. Only this module touches the network.
// Uses the official SDK with dangerouslyAllowBrowser, which sends the
// `anthropic-dangerous-direct-browser-access: true` header required for direct calls from an extension.
import Anthropic from '@anthropic-ai/sdk';
import type { ErrorCode, TutorError, UsageReport } from '../shared/messages';
import { SYSTEM_PROMPT } from '../shared/prompt';
import { estimateCost, type Effort } from '../shared/settings';

export interface StreamParams {
  apiKey: string;
  model: string;
  effort: Effort;
  messages: Anthropic.Beta.BetaMessageParam[];
  /** JSON schema for structured output (video map, quiz). */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
}

export interface StreamResult {
  text: string;
  stopReason: string | null;
  usage: UsageReport;
  servedBy: string;
}

export class TutorApiError extends Error {
  constructor(public readonly info: TutorError) {
    super(info.message);
  }
}

export async function streamClaude(p: StreamParams): Promise<StreamResult> {
  const client = new Anthropic({ apiKey: p.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const stream = client.beta.messages.stream(
    {
      model: p.model,
      max_tokens: p.maxTokens ?? 64000,
      system: [{ type: 'text', text: SYSTEM_PROMPT }],
      messages: p.messages,
      // Adaptive thinking; summaries are streamed so the panel can show that the tutor is working.
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: {
        effort: p.effort,
        ...(p.schema ? { format: { type: 'json_schema' as const, schema: p.schema } } : {}),
      },
      // Server-side refusal fallback: on a policy decline the API reruns the request on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    },
    { signal: p.signal },
  );
  if (p.onText) stream.on('text', (d) => p.onText!(d));
  if (p.onThinking) stream.on('thinking', (d) => p.onThinking!(d));

  let final: Anthropic.Beta.BetaMessage;
  try {
    final = await stream.finalMessage();
  } catch (e) {
    throw new TutorApiError(toTutorError(e));
  }
  if (final.stop_reason === 'refusal') {
    throw new TutorApiError({ code: 'refusal', message: 'Claude declined to answer this request.', retryable: false });
  }
  const text = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const u = final.usage;
  const usage = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
  return { text, stopReason: final.stop_reason, usage: { ...usage, costUsd: estimateCost(final.model, usage) }, servedBy: final.model };
}

export function toTutorError(e: unknown): TutorError {
  const make = (code: ErrorCode, message: string, retryable: boolean): TutorError => ({ code, message, retryable });
  if (e instanceof TutorApiError) return e.info;
  if (e instanceof Anthropic.APIUserAbortError) return make('aborted', 'Stopped.', true);
  if (e instanceof Anthropic.AuthenticationError) return make('auth', 'The API key was rejected. Check it in Settings.', false);
  if (e instanceof Anthropic.PermissionDeniedError) return make('permission', 'This API key is not allowed to use the selected model. Pick another model in Settings.', false);
  if (e instanceof Anthropic.NotFoundError) return make('bad-request', 'The selected model was not found for this API key. Pick another model in Settings.', false);
  if (e instanceof Anthropic.RateLimitError) return make('rate-limit', 'Rate limited by the API. Wait a moment and try again.', true);
  if (e instanceof Anthropic.BadRequestError) return make('bad-request', `The API rejected the request: ${e.message}`, false);
  if (e instanceof Anthropic.APIConnectionError) return make('network', 'Could not reach the Claude API. Check your connection.', true);
  if (e instanceof Anthropic.APIError) {
    if (e.status === 413) return make('too-large', 'The request was too large (very long video or large image).', false);
    if (e.status === 529 || e.status === 503) return make('overloaded', 'The API is overloaded right now. Try again shortly.', true);
    if ((e.status ?? 0) >= 500) return make('unknown', `The API had an error (${e.status}). Try again.`, true);
    return make('unknown', e.message, false);
  }
  return make('unknown', e instanceof Error ? e.message : String(e), false);
}
