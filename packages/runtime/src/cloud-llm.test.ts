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
});

test('OPENAI_API_KEY routes gpt-family personas to chat completions', async (t) => {
  const requests = stubFetch(t, {
    payload: { choices: [{ message: { content: 'hello from gpt' } }] }
  });
  const llm = createDefaultLlm({
    persona: { ...basePersona, harness: 'codex', model: 'openai-codex/gpt-5.3-codex' },
    env: { OPENAI_API_KEY: 'sk-openai-test' },
    log: noopLog
  });
  assert.ok(llm);
  const result = await llm.complete('hi', { maxTokens: 32 });
  assert.equal(result, 'hello from gpt');
  const request = requests[0]!;
  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(request.headers['authorization'], 'Bearer sk-openai-test');
  assert.equal(request.body.model, 'gpt-5.3-codex'); // openai-codex/ prefix stripped
  assert.equal(request.body.max_completion_tokens, 32);
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
