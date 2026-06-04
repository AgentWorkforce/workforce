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
 *   3. CODEX_OAUTH_CREDENTIAL       — structured ChatGPT/Codex OAuth blob
 *      for the codex backend, shaped like the Codex CLI auth blob:
 *      `{tokens:{access_token,account_id}}`.
 *   4. CODEX_OAUTH_TOKEN + CODEX_ACCOUNT_ID — split env equivalent of #3.
 *   5. OPENAI_API_KEY               — OpenAI chat completions, bearer.
 *
 * When the persona's `model` names a provider family (a `claude-*` model
 * or an `anthropic/`-prefixed ref vs a `gpt-*` / `openai/`-prefixed one),
 * a credential for that family is preferred; otherwise the first
 * available source above wins. Returns undefined when no credential is
 * present so `buildCtx` keeps the existing throwing stub (its message
 * names the fix).
 */

const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';
const DEFAULT_OPENAI_MODEL = 'gpt-5.5';
const DEFAULT_CODEX_BACKEND_MODEL = 'gpt-5.5-codex';
const DEFAULT_MAX_TOKENS = 16_000;
const COMPLETE_TIMEOUT_MS = 120_000;
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const OPENAI_BASE_URL = 'https://api.openai.com';
// Private ChatGPT/Codex backend protocol, not a published OpenAI Platform API.
// Keep this leg pinned to the Codex CLI's observed request/stream contract and
// expect maintenance if chatgpt.com/backend-api/codex changes.
const CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_BACKEND_ORIGINATOR = 'codex_cli_rs';

export interface CloudLlmOptions {
  persona: PersonaSpec;
  env: NodeJS.ProcessEnv;
  log: WorkforceCtx['log'];
}

type PersonaModelFamily = 'anthropic' | 'openai' | 'codex';
type LlmProviderFamily = 'anthropic' | 'openai' | 'codex-backend';

interface LlmCredential {
  family: LlmProviderFamily;
  headers: Record<string, string>;
  source: string;
  accessToken?: string;
  accountId?: string;
  baseUrl?: string;
}

const CODEX_BACKEND_MODEL_BY_PERSONA_MODEL: Record<string, string> = {
  codex: DEFAULT_CODEX_BACKEND_MODEL,
  'codex-latest': DEFAULT_CODEX_BACKEND_MODEL,
  'codex-tuned': DEFAULT_CODEX_BACKEND_MODEL,
  'gpt-5.5': DEFAULT_CODEX_BACKEND_MODEL,
  'gpt-5.5-codex': 'gpt-5.5-codex',
  'gpt-5.4': 'gpt-5.4-codex',
  'gpt-5.4-codex': 'gpt-5.4-codex',
  'gpt-5.1': 'gpt-5.1-codex',
  'gpt-5.1-codex': 'gpt-5.1-codex'
};

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
  if (credential.family === 'codex-backend') {
    return codexBackendLlm(credential, model, options.log);
  }
  return openaiLlm(credential, model, options.log);
}

function selectCredential(
  env: NodeJS.ProcessEnv,
  preferred: PersonaModelFamily | null
): LlmCredential | null {
  const candidates: LlmCredential[] = [];
  const anthropicApiKey = nonEmpty(env.ANTHROPIC_API_KEY);
  const claudeOauth = nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN);
  const openaiApiKey = nonEmpty(env.OPENAI_API_KEY);
  const codexOauth = codexOauthCredential(env);

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
      headers: {
        authorization: `Bearer ${claudeOauth}`,
        // Claude Code setup-tokens are accepted by the Messages API only
        // with the OAuth beta header; a bare Bearer is rejected.
        'anthropic-beta': 'oauth-2025-04-20'
      },
      source: 'CLAUDE_CODE_OAUTH_TOKEN'
    });
  }
  if (codexOauth) {
    candidates.push({
      family: 'codex-backend',
      headers: {},
      source: codexOauth.source,
      accessToken: codexOauth.accessToken,
      accountId: codexOauth.accountId,
      baseUrl: codexOauth.baseUrl
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
    const match = preferredCredential(candidates, preferred);
    if (match) return match;
  }
  return candidates[0] ?? null;
}

function preferredCredential(
  candidates: LlmCredential[],
  preferred: PersonaModelFamily
): LlmCredential | undefined {
  if (preferred === 'anthropic') {
    return candidates.find((candidate) => candidate.family === 'anthropic');
  }
  if (preferred === 'codex') {
    return (
      candidates.find((candidate) => candidate.family === 'codex-backend') ??
      candidates.find((candidate) => candidate.family === 'openai')
    );
  }
  return (
    candidates.find((candidate) => candidate.family === 'openai') ??
    candidates.find((candidate) => candidate.family === 'codex-backend')
  );
}

function personaModelFamily(persona: PersonaSpec): PersonaModelFamily | null {
  const model = nonEmpty(persona.model);
  if (!model) return null;
  const normalized = model.toLowerCase();
  if (normalized.startsWith('anthropic/') || normalized.includes('claude')) return 'anthropic';
  if (normalized.startsWith('openai-codex/') || normalized.includes('codex')) return 'codex';
  if (normalized.startsWith('openai/') || normalized.includes('gpt-')) {
    return 'openai';
  }
  return null;
}

function resolveModel(persona: PersonaSpec, family: LlmProviderFamily): string {
  const personaFamily = personaModelFamily(persona);
  const personaModel = nonEmpty(persona.model);
  if (personaModel && credentialMatchesPersonaFamily(family, personaFamily)) {
    // Strip provider prefixes like `anthropic/` / `openai/` / `openai-codex/`.
    const slash = personaModel.indexOf('/');
    const stripped = slash >= 0 ? personaModel.slice(slash + 1) : personaModel;
    // Codex CLI models (gpt-*-codex) are not served by /v1/chat/completions —
    // they steer family selection above, but the completion call falls back
    // to the default chat model.
    if (family === 'openai' && stripped.toLowerCase().includes('codex')) {
      return DEFAULT_OPENAI_MODEL;
    }
    if (family === 'codex-backend') {
      return resolveCodexBackendModel(stripped);
    }
    return stripped;
  }
  if (family === 'anthropic') return DEFAULT_ANTHROPIC_MODEL;
  if (family === 'codex-backend') return DEFAULT_CODEX_BACKEND_MODEL;
  return DEFAULT_OPENAI_MODEL;
}

function credentialMatchesPersonaFamily(
  credentialFamily: LlmProviderFamily,
  personaFamily: PersonaModelFamily | null
): boolean {
  if (!personaFamily) return false;
  if (credentialFamily === 'anthropic') return personaFamily === 'anthropic';
  if (credentialFamily === 'codex-backend') {
    return personaFamily === 'codex' || personaFamily === 'openai';
  }
  return personaFamily === 'openai' || personaFamily === 'codex';
}

function resolveCodexBackendModel(model: string): string {
  const normalized = model.toLowerCase();
  // The ChatGPT/Codex backend serves Codex-tuned model slugs, not the
  // platform `/v1` model ids. This table intentionally mirrors only the
  // slugs we have observed in the Codex CLI/probes; treat additions here as
  // protocol maintenance, not an OpenAI platform model rollout.
  return CODEX_BACKEND_MODEL_BY_PERSONA_MODEL[normalized] ?? DEFAULT_CODEX_BACKEND_MODEL;
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

function codexBackendLlm(
  credential: LlmCredential,
  model: string,
  log: WorkforceCtx['log']
): LlmContext {
  const accessToken = credential.accessToken;
  const accountId = credential.accountId;
  if (!accessToken || !accountId) {
    throw new Error('ctx.llm: Codex backend OAuth credential is missing access token or account id');
  }

  return {
    async complete(prompt, opts) {
      const sessionId = randomId();
      const threadId = randomId();
      const body = {
        model,
        instructions: '',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: prompt }]
          }
        ],
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        reasoning: null,
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        max_output_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS
      };

      return postCodexBackendStream(
        `${(credential.baseUrl ?? CODEX_BACKEND_BASE_URL).replace(/\/+$/, '')}/responses`,
        {
          authorization: `Bearer ${accessToken}`,
          'chatgpt-account-id': accountId,
          originator: CODEX_BACKEND_ORIGINATOR,
          'session-id': sessionId,
          'thread-id': threadId,
          accept: 'text/event-stream',
          'content-type': 'application/json'
        },
        body,
        log
      );
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

async function postCodexBackendStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  log: WorkforceCtx['log']
): Promise<string> {
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
    log('warn', 'ctx.llm Codex backend request failed before a response', { url, error: message });
    throw new Error(`ctx.llm: request to ${url} failed: ${message}`);
  }
  if (!response.ok) {
    const detail = truncate(await response.text().catch(() => ''), 500);
    log('warn', 'ctx.llm Codex backend request returned an error status', {
      url,
      status: response.status,
      detail
    });
    throw new Error(`ctx.llm: ${url} returned ${response.status}: ${detail}`);
  }

  const raw = await response.text();
  const { text, completed } = parseCodexBackendSse(raw);
  if (!completed) {
    throw new Error('ctx.llm: Codex backend stream closed before response.completed');
  }
  if (!text) {
    throw new Error('ctx.llm: Codex backend response contained no output text');
  }
  return text;
}

function parseCodexBackendSse(raw: string): { text: string; completed: boolean } {
  const chunks = raw.split(/\r?\n\r?\n/);
  let text = '';
  let completed = false;
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta;
    } else if (event.type === 'response.output_item.done') {
      text += outputTextFromItem(event.item);
    } else if (event.type === 'response.completed') {
      completed = true;
    } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
      throw new Error(`ctx.llm: Codex backend stream returned ${String(event.type)}`);
    }
  }
  return { text, completed };
}

function outputTextFromItem(item: unknown): string {
  if (!isRecord(item) || !Array.isArray(item.content)) return '';
  return item.content
    .filter(
      (content): content is { type: 'output_text'; text: string } =>
        isRecord(content) && content.type === 'output_text' && typeof content.text === 'string'
    )
    .map((content) => content.text)
    .join('');
}

function codexOauthCredential(env: NodeJS.ProcessEnv):
  | { accessToken: string; accountId: string; source: string; baseUrl?: string }
  | null {
  const structured = nonEmpty(env.CODEX_OAUTH_CREDENTIAL);
  if (structured) {
    // The cloud resolver should refresh this auth blob before env injection
    // with refreshHarnessCliCredentialIfStale; runtime consumes the current
    // access_token/account_id and does not persist refreshed credentials.
    const parsed = parseCodexOauthCredential(structured);
    if (parsed) {
      const baseUrl = nonEmpty(env.CODEX_BACKEND_BASE_URL) ?? parsed.baseUrl;
      return {
        ...parsed,
        source: 'CODEX_OAUTH_CREDENTIAL',
        ...(baseUrl ? { baseUrl } : {})
      };
    }
  }

  const accessToken = nonEmpty(env.CODEX_OAUTH_TOKEN);
  const accountId = nonEmpty(env.CODEX_ACCOUNT_ID) ?? nonEmpty(env.CHATGPT_ACCOUNT_ID);
  if (!accessToken || !accountId) return null;
  const baseUrl = nonEmpty(env.CODEX_BACKEND_BASE_URL);
  return {
    accessToken,
    accountId,
    source: 'CODEX_OAUTH_TOKEN',
    ...(baseUrl ? { baseUrl } : {})
  };
}

function parseCodexOauthCredential(
  raw: string
): { accessToken: string; accountId: string; baseUrl?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : parsed;
  const accessToken =
    nonEmptyString(tokens.access_token) ??
    nonEmptyString(tokens.accessToken) ??
    nonEmptyString(parsed.CODEX_OAUTH_TOKEN);
  const accountId =
    nonEmptyString(tokens.account_id) ??
    nonEmptyString(tokens.accountId) ??
    nonEmptyString(parsed.account_id) ??
    nonEmptyString(parsed.accountId);
  if (!accessToken || !accountId) return null;
  const baseUrl = nonEmptyString(parsed.base_url) ?? nonEmptyString(parsed.baseUrl);
  return {
    accessToken,
    accountId,
    ...(baseUrl ? { baseUrl } : {})
  };
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' ? nonEmpty(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `wf-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}
