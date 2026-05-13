import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Daytona } from '@daytonaio/sdk';

import * as pkg from './index.js';
import { DaytonaRuntime, applyDaytonaAuthEnv, resolveDaytonaAuthCredentials } from './index.js';
import type { RuntimeHandle } from './index.js';

describe('public barrel', () => {
  it('exports DaytonaRuntime as a class', () => {
    assert.equal(typeof pkg.DaytonaRuntime, 'function');
    assert.equal(typeof DaytonaRuntime, 'function');
  });

  it('exports resolveDaytonaAuthCredentials and applyDaytonaAuthEnv', () => {
    assert.equal(typeof pkg.resolveDaytonaAuthCredentials, 'function');
    assert.equal(typeof resolveDaytonaAuthCredentials, 'function');
    assert.equal(typeof pkg.applyDaytonaAuthEnv, 'function');
    assert.equal(typeof applyDaytonaAuthEnv, 'function');
  });

  it('resolveDaytonaAuthCredentials normalises an apiKey-only input', () => {
    const resolved = resolveDaytonaAuthCredentials({ apiKey: 'sk-test' });
    assert.ok('apiKey' in resolved, 'expected apiKey-mode result');
    assert.equal(resolved.apiKey, 'sk-test');
  });

  it('resolveDaytonaAuthCredentials rejects empty input', () => {
    assert.throws(() => resolveDaytonaAuthCredentials({}));
  });

  it('applyDaytonaAuthEnv writes DAYTONA_API_KEY into the supplied env bag', () => {
    const env: Record<string, string> = {};
    applyDaytonaAuthEnv(env, { apiKey: 'sk-test' });
    assert.equal(env.DAYTONA_API_KEY, 'sk-test');
  });
});

const daytonaApiKey = process.env.DAYTONA_API_KEY?.trim();
const HAS_DAYTONA = Boolean(daytonaApiKey);
const SMOKE_LABEL = 'daytona-runner-smoke';

describe('DaytonaRuntime smoke', { concurrency: false }, () => {
  let runtime: DaytonaRuntime | undefined;
  let handle: RuntimeHandle | undefined;

  before(() => {
    if (!HAS_DAYTONA) return;
    const auth = resolveDaytonaAuthCredentials({
      apiKey: daytonaApiKey,
      jwtToken: process.env.DAYTONA_JWT_TOKEN,
      organizationId: process.env.DAYTONA_ORGANIZATION_ID,
    });
    const daytona = new Daytona(auth);
    runtime = new DaytonaRuntime({ daytona });
  });

  after(async () => {
    if (runtime && handle) {
      try {
        await runtime.destroy(handle);
      } catch {
        // best-effort cleanup; sandbox leaks surface via Daytona dashboard
      }
    }
  });

  it(
    'launches a sandbox, runs node -e, and destroys it',
    { skip: HAS_DAYTONA ? false : 'DAYTONA_API_KEY is not set', timeout: 120_000 },
    async () => {
      assert.ok(runtime, 'runtime should be initialised when DAYTONA_API_KEY is set');
      handle = await runtime.launch({ label: SMOKE_LABEL });
      const result = await runtime.exec(handle, "node -e 'console.log(\"ok\")'");
      assert.equal(
        result.exitCode,
        0,
        `expected exitCode 0, got ${result.exitCode}: ${result.output}`,
      );
      assert.match(
        result.output,
        /\bok\b/,
        `expected output to contain "ok", got: ${result.output}`,
      );
    },
  );
});
