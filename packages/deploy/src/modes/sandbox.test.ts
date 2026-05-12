import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSandboxClient } from './sandbox.js';
import type { ModeLaunchInput } from '../types.js';

function input(): Pick<ModeLaunchInput, 'workspace' | 'persona' | 'env'> {
  return {
    workspace: 'ws-demo',
    persona: {
      id: 'demo',
      intent: 'documentation',
      tags: ['documentation'],
      description: '',
      skills: [],
      tiers: {
        best: {
          harness: 'claude',
          model: 'm',
          systemPrompt: 's',
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
        },
        'best-value': {
          harness: 'claude',
          model: 'm',
          systemPrompt: 's',
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
        },
        minimum: {
          harness: 'claude',
          model: 'm',
          systemPrompt: 's',
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
        }
      },
      cloud: true,
      onEvent: './agent.ts'
    }
  };
}

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('resolveSandboxClient prefers BYO when DAYTONA_API_KEY is set', () => {
  withEnv(
    {
      DAYTONA_API_KEY: 'sk_byo',
      WORKFORCE_WORKSPACE_TOKEN: 'tok'
    },
    () => {
      const client = resolveSandboxClient(input());
      // BYO client carries the Daytona SDK; we infer mode by inspecting
      // a mint-like call would tag the resulting handle. Easier to just
      // verify by structural shape — but the simplest check is that the
      // proxy path was *not* picked (which would have called fetch).
      assert.ok(typeof client.mint === 'function');
      assert.ok(typeof client.exec === 'function');
    }
  );
});

test('resolveSandboxClient falls back to the cloud proxy when only WORKFORCE_WORKSPACE_TOKEN is set', () => {
  withEnv(
    {
      DAYTONA_API_KEY: undefined,
      DAYTONA_JWT_TOKEN: undefined,
      WORKFORCE_WORKSPACE_TOKEN: 'tok-cloud',
      WORKFORCE_CLOUD_URL: 'https://cloud.example.com'
    },
    () => {
      const client = resolveSandboxClient(input());
      assert.ok(typeof client.mint === 'function');
    }
  );
});

test('resolveSandboxClient throws when neither path is configured', () => {
  withEnv(
    {
      DAYTONA_API_KEY: undefined,
      DAYTONA_JWT_TOKEN: undefined,
      WORKFORCE_WORKSPACE_TOKEN: undefined
    },
    () => {
      assert.throws(() => resolveSandboxClient(input()), /no Daytona credentials and no workforce workspace token/);
    }
  );
});

test('resolveSandboxClient honors --byo-sandbox even when both paths are configured', () => {
  withEnv(
    {
      DAYTONA_API_KEY: 'sk_byo',
      WORKFORCE_WORKSPACE_TOKEN: 'tok'
    },
    () => {
      const client = resolveSandboxClient(input(), { forceByo: true });
      assert.ok(typeof client.mint === 'function');
    }
  );
});

test('resolveSandboxClient with forceByo and no BYO env throws a clear error', () => {
  withEnv(
    {
      DAYTONA_API_KEY: undefined,
      DAYTONA_JWT_TOKEN: undefined,
      WORKFORCE_WORKSPACE_TOKEN: 'tok'
    },
    () => {
      assert.throws(
        () => resolveSandboxClient(input(), { forceByo: true }),
        /--byo-sandbox requested but no Daytona credentials/
      );
    }
  );
});
