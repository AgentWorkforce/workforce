import type { HarnessRunResult } from './types.js';

export interface HarnessProviderFailure {
  kind: 'usage_limit' | 'rate_limit' | 'authentication' | 'context_limit' | 'provider_unavailable' | 'timeout';
  message: string;
  resetHint?: string;
  provider?: 'anthropic' | 'openai';
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function errorMessages(text: string): string[] {
  const messages: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line) as Record<string, unknown> | null;
      if (!value || typeof value !== 'object') continue;
      // CLI error envelopes, not arbitrary assistant/tool text in a stream.
      if (value.type === 'error' && typeof value.message === 'string') messages.push(value.message);
      if (value.type === 'result' && value.is_error === true && typeof value.result === 'string') messages.push(value.result);
      if (value.type === 'turn.failed' && value.error && typeof value.error === 'object') {
        const message = (value.error as { message?: unknown }).message;
        if (typeof message === 'string') messages.push(message);
      }
    } catch {
      // Most CLIs print plain text diagnostics.
    }
  }
  return messages;
}

/**
 * Classify failed model CLI runs, never arbitrary successful agent output.
 * Customer messages are fixed templates, not excerpts of stdout/stderr:
 * those streams can contain code, credentials, and unfinished task output.
 */
export function classifyHarnessProviderFailure(run: Pick<HarnessRunResult, 'output' | 'stderr' | 'exitCode'>, harness?: string): HarnessProviderFailure | null {
  // OS kills and successful output retain their existing caller contract.
  if (!Number.isFinite(run.exitCode) || run.exitCode === 0 || run.exitCode === 137 || run.exitCode === 143) return null;
  const provider = harness === 'claude' ? 'anthropic' : harness === 'codex' ? 'openai' : undefined;
  const account = provider === 'anthropic' ? 'Claude' : provider === 'openai' ? 'OpenAI' : 'AI';
  const result = run as { output?: unknown; stderr?: unknown } | null;
  const rawText = [result?.output, result?.stderr]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.slice(-16000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''))
    .join('\n');
  const text = [rawText, ...errorMessages(rawText)].join('\n');

  const claudeLimit = text.match(/^\s*You['’]ve hit your (?:usage )?limit\b([^\r\n]*)/im);
  if (claudeLimit) {
    // Only copy a clock time with an explicit timezone. Do not echo the
    // remainder of an arbitrary line or invent an absolute reset date.
    const reset = claudeLimit[1].match(
      /\bresets\s+((?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*[ap]m|(?:[01]?\d|2[0-3]):[0-5]\d)\s*\((UTC|GMT|[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\)(?=$|[\s.,;])/i,
    );
    const resetHint = reset && validTimezone(reset[2]) ? `${reset[1].trim()} (${reset[2]})` : undefined;
    return {
      ...(provider ? { provider } : {}),
      kind: 'usage_limit',
      message: [
        `The ${account} account selected for this run has reached its usage limit.`,
        ...(resetHint ? [`The provider reports a reset at ${resetHint}.`] : []),
        'Wait for the limit to reset, or ask the account owner to restore available usage before retrying the task.',
      ].join(' '),
      ...(resetHint ? { resetHint } : {}),
    };
  }

  if (/"(?:type|code)"\s*:\s*"(?:insufficient_quota|billing_hard_limit_reached)"|\byou exceeded your current quota\b|\byour credit balance is too low to access the Anthropic API\b/i.test(text)) {
    return {
      ...(provider ? { provider } : {}),
      kind: 'usage_limit',
      message: 'The AI account used for this run has no available quota or credits. Ask the account owner to check usage and billing and restore capacity before retrying the task.',
    };
  }

  if (/"(?:type|code)"\s*:\s*"(?:rate_limit_error|rate_limit_exceeded)"|^\s*API Error:\s*429\b|\bThis request would exceed your account's rate limit\b/im.test(text)) {
    return {
      ...(provider ? { provider } : {}),
      kind: 'rate_limit',
      message: 'The AI provider rate-limited this run. Wait for available capacity before retrying; if this persists, ask the account owner to check the account limits.',
    };
  }

  if (/"(?:type|code)"\s*:\s*"(?:authentication_error|invalid_api_key)"|^\s*API Error:\s*401\b|^\s*Invalid API key\b.*\/login|\bOAuth token has expired\b/im.test(text)) {
    return {
      ...(provider ? { provider } : {}),
      kind: 'authentication',
      message: 'The AI provider rejected the credentials used for this run. Ask the account owner to reconnect the AI account before retrying the task.',
    };
  }

  if (/"(?:type|code)"\s*:\s*"context_length_exceeded"|"message"\s*:\s*"prompt is too long\b|^\s*(?:API Error:\s*400\s+)?prompt is too long\b/im.test(text)) {
    return {
      ...(provider ? { provider } : {}),
      kind: 'context_limit',
      message: 'The task input exceeds the AI model context limit. Reduce the task scope or select a model with a larger context window before retrying.',
    };
  }

  if (/^\s*API Error:\s*(?:Request timed out|Request timeout)\b|"(?:type|code)"\s*:\s*"(?:request_timeout|timeout_error)"/im.test(text)) {
    return {
      ...(provider ? { provider } : {}),
      kind: 'timeout',
      message: 'The AI request for this run timed out. Retry when the provider is responsive; if this persists, an operator should check the request timeout and task scope.',
    };
  }

  if (/"type"\s*:\s*"overloaded_error"|^\s*API Error:\s*(?:500|502|503|504|529)\b/im.test(text)) {
    return {
      ...(provider ? { provider } : {}),
      kind: 'provider_unavailable',
      message: 'The AI provider could not serve this run request. Retry after the provider recovers; if this persists, an operator should check provider availability.',
    };
  }

  return null;
}

/** Recognized provider failure, shared by every ctx.harness.run caller. */
export class HarnessProviderError extends Error {
  readonly providerFailure: HarnessProviderFailure;
  readonly result!: HarnessRunResult;

  constructor(failure: HarnessProviderFailure, result: HarnessRunResult) {
    super(failure.message);
    this.name = 'HarnessProviderError';
    this.providerFailure = Object.freeze({ ...failure });
    // Retain diagnostics for explicit recovery without serializing secrets
    // when the error is logged or passed to a customer-facing surface.
    Object.defineProperty(this, 'result', { value: result, enumerable: false });
  }
}
