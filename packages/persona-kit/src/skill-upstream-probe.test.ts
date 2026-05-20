import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildUpstreamRecordsFromCacheDir,
  detectSkillUpstreamDrift,
  isUpstreamCheckDue,
  parseCheckInterval
} from './skill-upstream-probe.js';
import type { SkillCacheMarker } from './skill-cache.js';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'persona-kit-upstream-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Minimal Response-like stub. Only the fields the probe touches:
 * `ok`, `status`, `json()`.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

function statusResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('no body');
    }
  } as unknown as Response;
}

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): { fetchImpl: FetchStub; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchStub = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

// --- parseCheckInterval --------------------------------------------------

test('parseCheckInterval: units', () => {
  assert.equal(parseCheckInterval('500ms'), 500);
  assert.equal(parseCheckInterval('90s'), 90_000);
  assert.equal(parseCheckInterval('30m'), 1_800_000);
  assert.equal(parseCheckInterval('24h'), 86_400_000);
  assert.equal(parseCheckInterval('2d'), 172_800_000);
  assert.equal(parseCheckInterval('12'), 12 * 3_600_000); // bare number = hours
});

test('parseCheckInterval: sentinels', () => {
  assert.equal(parseCheckInterval('0'), 0); // always
  assert.equal(parseCheckInterval('never'), null);
  assert.equal(parseCheckInterval('off'), null);
  assert.equal(parseCheckInterval('false'), null);
});

test('parseCheckInterval: unparseable / empty → undefined (caller default)', () => {
  assert.equal(parseCheckInterval(undefined), undefined);
  assert.equal(parseCheckInterval(''), undefined);
  assert.equal(parseCheckInterval('  '), undefined);
  assert.equal(parseCheckInterval('soon'), undefined);
  assert.equal(parseCheckInterval('10x'), undefined);
});

// --- isUpstreamCheckDue --------------------------------------------------

function marker(partial: Partial<SkillCacheMarker> = {}): SkillCacheMarker {
  return {
    schemaVersion: 2,
    fingerprint: 'fp',
    harness: 'claude',
    installedAt: '2026-05-01T00:00:00.000Z',
    skills: [],
    ...partial
  };
}

test('isUpstreamCheckDue: never (null) is always false', () => {
  assert.equal(isUpstreamCheckDue(marker(), null), false);
});

test('isUpstreamCheckDue: always (0) is always true', () => {
  assert.equal(
    isUpstreamCheckDue(marker({ lastUpstreamCheckAt: new Date().toISOString() }), 0),
    true
  );
});

test('isUpstreamCheckDue: no prior check → due', () => {
  assert.equal(isUpstreamCheckDue(marker(), 3_600_000), true);
});

test('isUpstreamCheckDue: respects the interval window', () => {
  const now = Date.parse('2026-05-15T12:00:00.000Z');
  const fresh = marker({ lastUpstreamCheckAt: '2026-05-15T11:30:00.000Z' });
  const stale = marker({ lastUpstreamCheckAt: '2026-05-15T10:00:00.000Z' });
  assert.equal(isUpstreamCheckDue(fresh, 3_600_000, now), false); // 30m < 1h
  assert.equal(isUpstreamCheckDue(stale, 3_600_000, now), true); // 2h > 1h
});

test('isUpstreamCheckDue: corrupt timestamp → due', () => {
  assert.equal(
    isUpstreamCheckDue(marker({ lastUpstreamCheckAt: 'not-a-date' }), 3_600_000),
    true
  );
});

// --- buildUpstreamRecordsFromCacheDir ------------------------------------

test('buildUpstreamRecordsFromCacheDir: prpm version from prpm.lock', async () => {
  await withTmpDir(async (dir) => {
    await writeFile(
      join(dir, 'prpm.lock'),
      JSON.stringify({
        packages: {
          '@agent-relay/foo#claude': { version: '1.2.3' }
        }
      }),
      'utf8'
    );
    const { fetchImpl } = recordingFetch(() => jsonResponse({}));
    const recs = await buildUpstreamRecordsFromCacheDir(
      dir,
      [{ id: 'foo', source: '@agent-relay/foo' }],
      { fetchImpl }
    );
    const r = recs.get('foo');
    assert.ok(r && r.kind === 'prpm');
    assert.equal(r.version, '1.2.3');
    assert.equal(r.packageRef, '@agent-relay/foo');
  });
});

test('buildUpstreamRecordsFromCacheDir: github blob sha from skills-lock.json + GitHub GET', async () => {
  await withTmpDir(async (dir) => {
    await writeFile(
      join(dir, 'skills-lock.json'),
      JSON.stringify({
        skills: {
          'find-skills': {
            source: 'vercel-labs/skills',
            sourceType: 'github',
            skillPath: 'skills/find-skills/SKILL.md'
          }
        }
      }),
      'utf8'
    );
    const { fetchImpl, calls } = recordingFetch((url) => {
      assert.match(
        url,
        /api\.github\.com\/repos\/vercel-labs\/skills\/contents\/skills\/find-skills\/SKILL\.md/
      );
      return jsonResponse({ sha: 'deadbeef' });
    });
    const recs = await buildUpstreamRecordsFromCacheDir(
      dir,
      [{ id: 'fs', source: 'https://github.com/vercel-labs/skills#find-skills' }],
      { fetchImpl }
    );
    const r = recs.get('fs');
    assert.ok(r && r.kind === 'github-blob');
    assert.equal(r.sha, 'deadbeef');
    assert.equal(calls.length, 1);
  });
});

test('buildUpstreamRecordsFromCacheDir: local source → undefined record', async () => {
  await withTmpDir(async (dir) => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}));
    const recs = await buildUpstreamRecordsFromCacheDir(
      dir,
      [{ id: 'loc', source: './skills/local.md' }],
      { fetchImpl }
    );
    assert.ok(recs.has('loc'));
    assert.equal(recs.get('loc'), undefined);
  });
});

test('buildUpstreamRecordsFromCacheDir: github GET failure → undefined (fail-open)', async () => {
  await withTmpDir(async (dir) => {
    await writeFile(
      join(dir, 'skills-lock.json'),
      JSON.stringify({
        skills: { x: { skillPath: 'skills/x/SKILL.md' } }
      }),
      'utf8'
    );
    const { fetchImpl } = recordingFetch(() => statusResponse(503));
    const recs = await buildUpstreamRecordsFromCacheDir(
      dir,
      [{ id: 'x', source: 'https://github.com/o/r#x' }],
      { fetchImpl }
    );
    assert.equal(recs.get('x'), undefined);
  });
});

// --- detectSkillUpstreamDrift -------------------------------------------

test('detectSkillUpstreamDrift: prpm version unchanged → no drift', async () => {
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse({ latest_version: { version: '1.0.0' } })
  );
  const res = await detectSkillUpstreamDrift(
    marker({
      skills: [
        {
          id: 'foo',
          source: '@o/foo',
          upstream: { kind: 'prpm', packageRef: '@o/foo', version: '1.0.0' }
        }
      ]
    }),
    { fetchImpl }
  );
  assert.equal(res.drifted, false);
  assert.equal(res.details[0]?.drifted, false);
});

test('detectSkillUpstreamDrift: prpm version bumped → drift', async () => {
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse({ latest_version: { version: '1.1.3' } })
  );
  const res = await detectSkillUpstreamDrift(
    marker({
      skills: [
        {
          id: 'foo',
          source: '@o/foo',
          upstream: { kind: 'prpm', packageRef: '@o/foo', version: '1.0.0' }
        }
      ]
    }),
    { fetchImpl }
  );
  assert.equal(res.drifted, true);
  assert.match(res.details[0]?.note ?? '', /1\.0\.0 → 1\.1\.3/);
});

test('detectSkillUpstreamDrift: prpm registry 500 → fail-open (no drift)', async () => {
  const { fetchImpl } = recordingFetch(() => statusResponse(500));
  const res = await detectSkillUpstreamDrift(
    marker({
      skills: [
        {
          id: 'foo',
          source: '@o/foo',
          upstream: { kind: 'prpm', packageRef: '@o/foo', version: '1.0.0' }
        }
      ]
    }),
    { fetchImpl }
  );
  assert.equal(res.drifted, false);
  assert.match(res.details[0]?.note ?? '', /fail-open/);
});

test('detectSkillUpstreamDrift: github 304 (If-None-Match) → no drift', async () => {
  const { fetchImpl, calls } = recordingFetch(() => statusResponse(304));
  const res = await detectSkillUpstreamDrift(
    marker({
      skills: [
        {
          id: 'gh',
          source: 'https://github.com/o/r#x',
          upstream: {
            kind: 'github-blob',
            blobUrl: 'https://api.github.com/repos/o/r/contents/skills/x/SKILL.md',
            sha: 'abc123'
          }
        }
      ]
    }),
    { fetchImpl }
  );
  assert.equal(res.drifted, false);
  assert.equal(calls[0]?.init?.headers && (calls[0].init.headers as Record<string, string>)['if-none-match'], '"abc123"');
});

test('detectSkillUpstreamDrift: github new sha → drift', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse({ sha: 'newsha999' }));
  const res = await detectSkillUpstreamDrift(
    marker({
      skills: [
        {
          id: 'gh',
          source: 'https://github.com/o/r#x',
          upstream: {
            kind: 'github-blob',
            blobUrl: 'https://api.github.com/repos/o/r/contents/skills/x/SKILL.md',
            sha: 'oldsha000'
          }
        }
      ]
    }),
    { fetchImpl }
  );
  assert.equal(res.drifted, true);
  assert.match(res.details[0]?.note ?? '', /oldsha000.*→.*newsha999/);
});

test('detectSkillUpstreamDrift: github 404 → fail-open (no drift)', async () => {
  const { fetchImpl } = recordingFetch(() => statusResponse(404));
  const res = await detectSkillUpstreamDrift(
    marker({
      skills: [
        {
          id: 'gh',
          source: 'https://github.com/o/r#x',
          upstream: {
            kind: 'github-blob',
            blobUrl: 'https://api.github.com/repos/o/r/contents/skills/x/SKILL.md',
            sha: 'abc'
          }
        }
      ]
    }),
    { fetchImpl }
  );
  assert.equal(res.drifted, false);
  assert.match(res.details[0]?.note ?? '', /fail-open/);
});

test('detectSkillUpstreamDrift: remote skill missing upstream record → drift (capture next time)', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse({}));
  const res = await detectSkillUpstreamDrift(
    marker({
      skills: [{ id: 'foo', source: '@agent-relay/foo' }] // no upstream
    }),
    { fetchImpl }
  );
  assert.equal(res.drifted, true);
  assert.match(res.details[0]?.note ?? '', /no upstream record/);
});

test('detectSkillUpstreamDrift: local skill missing upstream record → skipped (no drift)', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse({}));
  const res = await detectSkillUpstreamDrift(
    marker({
      skills: [{ id: 'loc', source: './skills/x.md' }]
    }),
    { fetchImpl }
  );
  assert.equal(res.drifted, false);
  assert.equal(res.details.length, 0);
});

test('detectSkillUpstreamDrift: mixed set — one drift flips the whole result', async () => {
  const { fetchImpl } = recordingFetch((url) => {
    if (url.includes('registry.prpm.dev')) {
      return jsonResponse({ latest_version: { version: '1.0.0' } }); // unchanged
    }
    return jsonResponse({ sha: 'moved' }); // github drifted
  });
  const res = await detectSkillUpstreamDrift(
    marker({
      skills: [
        {
          id: 'p',
          source: '@o/p',
          upstream: { kind: 'prpm', packageRef: '@o/p', version: '1.0.0' }
        },
        {
          id: 'g',
          source: 'https://github.com/o/r#x',
          upstream: {
            kind: 'github-blob',
            blobUrl: 'https://api.github.com/repos/o/r/contents/x/SKILL.md',
            sha: 'orig'
          }
        }
      ]
    }),
    { fetchImpl }
  );
  assert.equal(res.drifted, true);
  assert.equal(res.details.find((d) => d.skillId === 'p')?.drifted, false);
  assert.equal(res.details.find((d) => d.skillId === 'g')?.drifted, true);
});

test('detectSkillUpstreamDrift: probe timeout → fail-open', async () => {
  const fetchImpl: FetchStub = (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener('abort', () =>
          reject(new Error('aborted'))
        );
      }
    });
  const res = await detectSkillUpstreamDrift(
    marker({
      skills: [
        {
          id: 'foo',
          source: '@o/foo',
          upstream: { kind: 'prpm', packageRef: '@o/foo', version: '1.0.0' }
        }
      ]
    }),
    { fetchImpl, timeoutMs: 50 }
  );
  assert.equal(res.drifted, false);
  assert.match(res.details[0]?.note ?? '', /fail-open/);
});
