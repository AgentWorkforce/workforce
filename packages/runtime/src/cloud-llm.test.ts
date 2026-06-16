import test from 'node:test';
import assert from 'node:assert/strict';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import { createDefaultLlm } from './cloud-llm.js';

const basePersona: PersonaSpec = {
  id: 'demo',
  intent: 'documentation',
  tags: ['documentation'],
  description: 'test persona',
  skills: [],
  harness: 'claude',
  model: 'anthropic/claude-sonnet-4-6',
  systemPrompt: 'be helpful',
  harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
  cloud: true
};

const noopLog = () => {};

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stubFetch(
  t: { after(fn: () => void): void },
  response: { status?: number; payload?: unknown; rawBody?: string }
): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
          key.toLowerCase(),
          value
        ])
      ),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    });
    const status = response.status ?? 200;
    const body = response.rawBody ?? JSON.stringify(response.payload ?? {});
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

test('returns undefined when the sandbox has no LLM credentials', () => {
  const llm = createDefaultLlm({ persona: basePersona, env: {}, log: noopLog });
  assert.equal(llm, undefined);
});

test('ANTHROPIC_API_KEY produces an x-api-key Messages API client', async (t) => {
  const requests = stubFetch(t, {
    payload: { content: [{ type: 'text', text: 'hello from claude' }] }
  });
  const llm = createDefaultLlm({
    persona: basePersona,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    log: noopLog
  });
  assert.ok(llm);
  const result = await llm.complete('hi', { maxTokens: 64 });
  assert.equal(result, 'hello from claude');
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'sk-ant-test');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.headers['authorization'], undefined);
  assert.equal(request.headers['anthropic-beta'], undefined); // beta header is OAuth-leg-only
  assert.equal(request.body.model, 'claude-sonnet-4-6'); // anthropic/ prefix stripped
  assert.equal(request.body.max_tokens, 64);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'hi' }]);
});

test('CLAUDE_CODE_OAUTH_TOKEN authenticates via Authorization: Bearer only', async (t) => {
  const requests = stubFetch(t, {
    payload: { content: [{ type: 'text', text: 'ok' }] }
  });
  const llm = createDefaultLlm({
    persona: basePersona,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oat-token' },
    log: noopLog
  });
  assert.ok(llm);
  await llm.complete('hi');
  const request = requests[0]!;
  assert.equal(request.headers['authorization'], 'Bearer oat-token');
  assert.equal(request.headers['x-api-key'], undefined);
  // Setup-tokens are rejected by /v1/messages without the OAuth beta header.
  assert.equal(request.headers['anthropic-beta'], 'oauth-2025-04-20');
});

test('codex-only persona models fall back to the default chat model', async (t) => {
  const requests = stubFetch(t, {
    payload: { choices: [{ message: { content: 'ok' } }] }
  });
  const llm = createDefaultLlm({
    persona: { ...basePersona, harness: 'codex', model: 'openai-codex/gpt-5.5-codex' },
    env: { OPENAI_API_KEY: 'sk-openai-test' },
    log: noopLog
  });
  assert.ok(llm);
  await llm.complete('hi');
  // gpt-*-codex is a Codex CLI model, not served by /v1/chat/completions.
  assert.equal(requests[0]!.body.model, 'gpt-5.5');
});

test('CODEX_OAUTH_TOKEN routes codex personas to the ChatGPT codex backend', async (t) => {
  const requests = stubFetch(t, {
    rawBody: [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp-1"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"hello "}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"from codex"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp-1"}}',
      '',
      ''
    ].join('\n')
  });
  const llm = createDefaultLlm({
    persona: { ...basePersona, harness: 'codex', model: 'openai-codex/gpt-5.5-codex' },
    env: { CODEX_OAUTH_TOKEN: 'chatgpt-access', CODEX_ACCOUNT_ID: 'acct-123' },
    log: noopLog
  });
  assert.ok(llm);
  const result = await llm.complete('hi', { maxTokens: 48 });
  assert.equal(result, 'hello from codex');
  const request = requests[0]!;
  assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(request.headers['authorization'], 'Bearer chatgpt-access');
  assert.equal(request.headers['chatgpt-account-id'], 'acct-123');
  assert.equal(request.headers.originator, 'codex_cli_rs');
  assert.ok(request.headers['session-id']);
  assert.ok(request.headers['thread-id']);
  assert.equal(request.headers.accept, 'text/event-stream');
  assert.equal(request.headers['x-api-key'], undefined);
  assert.equal(request.body.model, 'gpt-5.5-codex');
  assert.equal(request.body.stream, true);
  assert.equal(request.body.max_output_tokens, 48);
  assert.deepEqual(request.body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(request.body.input, [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hi' }]
    }
  ]);
});

test('CODEX_OAUTH_CREDENTIAL accepts refreshed auth blob shape with account_id', async (t) => {
  const requests = stubFetch(t, {
    rawBody: [
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"blob ok"}]}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp-1"}}',
      '',
      ''
    ].join('\n')
  });
  const llm = createDefaultLlm({
    persona: { ...basePersona, harness: 'codex', model: 'openai/gpt-5.5' },
    env: {
      CODEX_OAUTH_CREDENTIAL: JSON.stringify({
        tokens: {
          access_token: 'fresh-access',
          refresh_token: 'refresh',
          account_id: 'acct-blob'
        },
        last_refresh: '2026-06-04T20:00:00.000Z',
        base_url: 'https://example.test/backend-api/codex'
      })
    },
    log: noopLog
  });
  assert.ok(llm);
  const result = await llm.complete('hi');
  assert.equal(result, 'blob ok');
  const request = requests[0]!;
  assert.equal(request.url, 'https://example.test/backend-api/codex/responses');
  assert.equal(request.headers['authorization'], 'Bearer fresh-access');
  assert.equal(request.headers['chatgpt-account-id'], 'acct-blob');
  assert.equal(request.body.model, 'gpt-5.5-codex'); // platform slug mapped to backend codex slug
});

test('OPENAI_API_KEY routes gpt-family personas to chat completions', async (t) => {
  const requests = stubFetch(t, {
    payload: { choices: [{ message: { content: 'hello from gpt' } }] }
  });
  const llm = createDefaultLlm({
    persona: { ...basePersona, harness: 'codex', model: 'openai/gpt-5.4' },
    env: { OPENAI_API_KEY: 'sk-openai-test' },
    log: noopLog
  });
  assert.ok(llm);
  const result = await llm.complete('hi', { maxTokens: 32 });
  assert.equal(result, 'hello from gpt');
  const request = requests[0]!;
  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(request.headers['authorization'], 'Bearer sk-openai-test');
  assert.equal(request.body.model, 'gpt-5.4'); // openai/ prefix stripped
  assert.equal(request.body.max_completion_tokens, 32);
});

test('OPENAI_API_KEY remains preferred over codex backend for plain gpt personas', async (t) => {
  const requests = stubFetch(t, {
    payload: { choices: [{ message: { content: 'platform answer' } }] }
  });
  const llm = createDefaultLlm({
    persona: { ...basePersona, harness: 'codex', model: 'openai/gpt-5.4' },
    env: {
      OPENAI_API_KEY: 'sk-openai-test',
      CODEX_OAUTH_TOKEN: 'chatgpt-access',
      CODEX_ACCOUNT_ID: 'acct-123'
    },
    log: noopLog
  });
  assert.ok(llm);
  const result = await llm.complete('hi');
  assert.equal(result, 'platform answer');
  assert.equal(requests[0]!.url, 'https://api.openai.com/v1/chat/completions');
});

test('codex backend is the OpenAI fallback when the persona model names no family', async (t) => {
  const requests = stubFetch(t, {
    rawBody: [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"subscription answer"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp-1"}}',
      '',
      ''
    ].join('\n')
  });
  const llm = createDefaultLlm({
    persona: { ...basePersona, model: undefined },
    env: {
      OPENAI_API_KEY: 'sk-openai-test',
      CODEX_OAUTH_TOKEN: 'chatgpt-access',
      CODEX_ACCOUNT_ID: 'acct-123'
    },
    log: noopLog
  });
  assert.ok(llm);
  const result = await llm.complete('hi');
  assert.equal(result, 'subscription answer');
  assert.equal(requests[0]!.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(requests[0]!.headers['authorization'], 'Bearer chatgpt-access');
  assert.equal(requests[0]!.headers['chatgpt-account-id'], 'acct-123');
  assert.equal(requests[0]!.body.model, 'gpt-5.5-codex');
});

test('persona model family wins when multiple credentials exist', async (t) => {
  const requests = stubFetch(t, {
    payload: { choices: [{ message: { content: 'gpt answer' } }] }
  });
  const llm = createDefaultLlm({
    persona: { ...basePersona, harness: 'codex', model: 'gpt-5.1' },
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-openai-test' },
    log: noopLog
  });
  assert.ok(llm);
  await llm.complete('hi');
  assert.equal(requests[0]!.url, 'https://api.openai.com/v1/chat/completions');
});

test('codex backend stream must reach response.completed', async (t) => {
  stubFetch(t, {
    rawBody: [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      '',
      ''
    ].join('\n')
  });
  const llm = createDefaultLlm({
    persona: { ...basePersona, harness: 'codex', model: 'openai-codex/gpt-5.5-codex' },
    env: { CODEX_OAUTH_TOKEN: 'chatgpt-access', CODEX_ACCOUNT_ID: 'acct-123' },
    log: noopLog
  });
  assert.ok(llm);
  await assert.rejects(llm.complete('hi'), /response\.completed/);
});

test('anthropic credential is the default when the persona model names no family', async (t) => {
  const requests = stubFetch(t, {
    payload: { content: [{ type: 'text', text: 'ok' }] }
  });
  const llm = createDefaultLlm({
    persona: { ...basePersona, model: undefined },
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-openai-test' },
    log: noopLog
  });
  assert.ok(llm);
  await llm.complete('hi');
  const request = requests[0]!;
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.body.model, 'claude-opus-4-8');
});

test('non-2xx responses throw with status and detail', async (t) => {
  stubFetch(t, { status: 401, rawBody: '{"error":{"message":"bad key"}}' });
  const llm = createDefaultLlm({
    persona: basePersona,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    log: noopLog
  });
  assert.ok(llm);
  await assert.rejects(llm.complete('hi'), /401/);
});

test('empty text content throws instead of returning an empty string', async (t) => {
  stubFetch(t, { payload: { content: [], stop_reason: 'max_tokens' } });
  const llm = createDefaultLlm({
    persona: basePersona,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    log: noopLog
  });
  assert.ok(llm);
  await assert.rejects(llm.complete('hi'), /no text content/);
});

test('OPENCODE_API_KEY routes opencode personas to OpenRouter chat completions', async (t) => {
  const requests = stubFetch(t, {
    payload: { choices: [{ message: { content: 'hello from deepseek' } }] }
  });
  const llm = createDefaultLlm({
    persona: { ...basePersona, harness: 'opencode', model: 'deepseek-v4-flash-free' },
    env: { OPENCODE_API_KEY: 'sk-oc-test' },
    log: noopLog
  });
  assert.ok(llm);
  const result = await llm.complete('hi', { maxTokens: 512 });
  assert.equal(result, 'hello from deepseek');
  const request = requests[0]!;
  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.headers['authorization'], 'Bearer sk-oc-test');
  assert.equal(request.body.model, 'deepseek-v4-flash-free');
  assert.equal(request.body.max_tokens, 512);
});

test('opencode harness prefers OPENCODE_API_KEY over ANTHROPIC_API_KEY', async (t) => {
  const requests = stubFetch(t, {
    payload: { choices: [{ message: { content: 'opencode wins' } }] }
  });
  const llm = createDefaultLlm({
    persona: { ...basePersona, harness: 'opencode', model: 'deepseek-v4-flash-free' },
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENCODE_API_KEY: 'sk-oc-test' },
    log: noopLog
  });
  assert.ok(llm);
  await llm.complete('hi');
  assert.equal(requests[0]!.url, 'https://openrouter.ai/api/v1/chat/completions');
});
