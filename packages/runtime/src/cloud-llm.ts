import type { PersonaSpec } from '@agentworkforce/persona-kit';
import type { LlmContext, WorkforceCtx } from './types.js';

/**
 * Env-derived `ctx.llm` for cloud-deployed personas.
 *
 * Until this existed, NOTHING constructed an LlmContext for deployed
 * personas — `buildCtx` only receives `llm` when a caller passes one, and
 * no caller ever did, so every cloud persona's `ctx.llm.complete()` threw
 * the UNAVAILABLE_LLM stub error regardless of `persona.useSubscription`
 * (which only gates harness-binary credential linking at deploy time).
 * The gap stayed invisible for months because the personas that call
 * `ctx.llm` (linear-chat-lead, granola, hn-monitor) failed earlier in
 * their handlers; the linear CWD fix advanced execution onto this cliff.
 *
 * Credential sources, in order:
 *   1. ANTHROPIC_API_KEY            — Anthropic Messages API, `x-api-key`.
 *   2. CLAUDE_CODE_OAUTH_TOKEN      — `claude setup-token` OAuth bearer
 *      (cloud#1629 injects it for `oauth_token` provider credentials).
 *      Sent as `Authorization: Bearer`, never via `x-api-key`.
 *   3. OPENAI_API_KEY               — OpenAI chat completions, bearer.
 *
 * When the persona's `model` names a provider family (a `claude-*` model
 * or an `anthropic/`-prefixed ref vs a `gpt-*` / `openai/`-prefixed one),
 * a credential for that family is preferred; otherwise the first
 * available source above wins. Returns undefined when no credential is
 * present so `buildCtx` keeps the existing throwing stub (its message
 * names the fix).
 */

const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';
const DEFAULT_OPENAI_MODEL = 'gpt-5.1';
const DEFAULT_MAX_TOKENS = 16_000;
const COMPLETE_TIMEOUT_MS = 120_000;
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const OPENAI_BASE_URL = 'https://api.openai.com';

export interface CloudLlmOptions {
  persona: PersonaSpec;
  env: NodeJS.ProcessEnv;
  log: WorkforceCtx['log'];
}

type LlmProviderFamily = 'anthropic' | 'openai';

interface LlmCredential {
  family: LlmProviderFamily;
  headers: Record<string, string>;
  source: string;
}

export function createDefaultLlm(options: CloudLlmOptions): LlmContext | undefined {
  const credential = selectCredential(options.env, personaModelFamily(options.persona));
  if (!credential) return undefined;

  const model = resolveModel(options.persona, credential.family);
  options.log('info', 'ctx.llm configured from sandbox credentials', {
    provider: credential.family,
    source: credential.source,
    model
  });

  if (credential.family === 'anthropic') {
    return anthropicLlm(credential, model, options.log);
  }
  return openaiLlm(credential, model, options.log);
}

function selectCredential(
  env: NodeJS.ProcessEnv,
  preferred: LlmProviderFamily | null
): LlmCredential | null {
  const candidates: LlmCredential[] = [];
  const anthropicApiKey = nonEmpty(env.ANTHROPIC_API_KEY);
  const claudeOauth = nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN);
  const openaiApiKey = nonEmpty(env.OPENAI_API_KEY);

  // Exactly one auth header per request: an OAuth bearer must go on
  // `Authorization`, an API key on `x-api-key`; sending both is rejected.
  if (anthropicApiKey) {
    candidates.push({
      family: 'anthropic',
      headers: { 'x-api-key': anthropicApiKey },
      source: 'ANTHROPIC_API_KEY'
    });
  } else if (claudeOauth) {
    candidates.push({
      family: 'anthropic',
      headers: { authorization: `Bearer ${claudeOauth}` },
      source: 'CLAUDE_CODE_OAUTH_TOKEN'
    });
  }
  if (openaiApiKey) {
    candidates.push({
      family: 'openai',
      headers: { authorization: `Bearer ${openaiApiKey}` },
      source: 'OPENAI_API_KEY'
    });
  }

  if (candidates.length === 0) return null;
  if (preferred) {
    const match = candidates.find((candidate) => candidate.family === preferred);
    if (match) return match;
  }
  return candidates[0] ?? null;
}

function personaModelFamily(persona: PersonaSpec): LlmProviderFamily | null {
  const model = nonEmpty(persona.model);
  if (!model) return null;
  const normalized = model.toLowerCase();
  if (normalized.startsWith('anthropic/') || normalized.includes('claude')) return 'anthropic';
  if (
    normalized.startsWith('openai/') ||
    normalized.startsWith('openai-codex/') ||
    normalized.includes('gpt-') ||
    normalized.includes('codex')
  ) {
    return 'openai';
  }
  return null;
}

function resolveModel(persona: PersonaSpec, family: LlmProviderFamily): string {
  const personaFamily = personaModelFamily(persona);
  const personaModel = nonEmpty(persona.model);
  if (personaModel && personaFamily === family) {
    // Strip provider prefixes like `anthropic/` / `openai/` / `openai-codex/`.
    const slash = personaModel.indexOf('/');
    return slash >= 0 ? personaModel.slice(slash + 1) : personaModel;
  }
  return family === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL;
}

function anthropicLlm(
  credential: LlmCredential,
  model: string,
  log: WorkforceCtx['log']
): LlmContext {
  return {
    async complete(prompt, opts) {
      const body = {
        model,
        max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }]
      };
      const payload = await postJson(
        `${ANTHROPIC_BASE_URL}/v1/messages`,
        {
          ...credential.headers,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body,
        log
      );
      const content = Array.isArray((payload as { content?: unknown }).content)
        ? ((payload as { content: unknown[] }).content)
        : [];
      const text = content
        .filter(
          (block): block is { type: 'text'; text: string } =>
            isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        )
        .map((block) => block.text)
        .join('');
      if (!text) {
        throw new Error(
          `ctx.llm: Anthropic response contained no text content (stop_reason=${String(
            (payload as { stop_reason?: unknown }).stop_reason ?? 'unknown'
          )})`
        );
      }
      return text;
    }
  };
}

function openaiLlm(
  credential: LlmCredential,
  model: string,
  log: WorkforceCtx['log']
): LlmContext {
  return {
    async complete(prompt, opts) {
      const body = {
        model,
        max_completion_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }]
      };
      const payload = await postJson(
        `${OPENAI_BASE_URL}/v1/chat/completions`,
        {
          ...credential.headers,
          'content-type': 'application/json'
        },
        body,
        log
      );
      const choices = (payload as { choices?: unknown }).choices;
      const first = Array.isArray(choices) ? choices[0] : undefined;
      const text =
        isRecord(first) && isRecord(first.message) && typeof first.message.content === 'string'
          ? first.message.content
          : '';
      if (!text) {
        throw new Error('ctx.llm: OpenAI response contained no message content');
      }
      return text;
    }
  };
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  log: WorkforceCtx['log']
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('warn', 'ctx.llm request failed before a response', { url, error: message });
    throw new Error(`ctx.llm: request to ${url} failed: ${message}`);
  }
  if (!response.ok) {
    const detail = truncate(await response.text().catch(() => ''), 500);
    log('warn', 'ctx.llm request returned an error status', {
      url,
      status: response.status,
      detail
    });
    throw new Error(`ctx.llm: ${url} returned ${response.status}: ${detail}`);
  }
  return (await response.json()) as unknown;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
