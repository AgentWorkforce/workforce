import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_REGISTRY,
  DEFAULT_UPDATE_CHECK_TIMEOUT_MS,
  compareVersions,
  fetchLatestVersion,
  formatUpdateNotice,
  isUpdateCheckDisabled,
  parseVersion,
  resolveInstallScope,
  resolveRegistryBase,
  resolveTimeoutMs,
  resolveUpdateCommand,
  resolveUpdateNotice,
  writeUpdateNotice
} from './update-check.js';

/** A `fetch` stand-in that records its calls and answers with a fixed body. */
function stubFetch(
  body: unknown,
  { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok,
      status,
      json: async () => {
        if (typeof body === 'string') throw new SyntaxError('not JSON');
        return body;
      }
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('parseVersion rejects anything that is not strict semver', () => {
  assert.deepEqual(parseVersion('4.1.45')?.numbers.map(String), ['4', '1', '45']);
  assert.equal(parseVersion('4.1.45-rc.1')?.prerelease, 'rc.1');
  assert.equal(parseVersion('latest'), undefined);
  assert.equal(parseVersion('4.1'), undefined);
  assert.equal(parseVersion('4.1.045'), undefined);
  assert.equal(parseVersion('4.1.0-rc.01'), undefined);
  assert.equal(parseVersion(undefined), undefined);
  assert.equal(parseVersion(42), undefined);
});

test('compareVersions orders releases, multi-digit parts, and prereleases', () => {
  assert.equal(compareVersions('4.1.45', '4.1.45'), 0);
  assert.equal(compareVersions('4.1.9', '4.1.10'), -1);
  assert.equal(compareVersions('4.2.0', '4.1.99'), 1);
  // A prerelease sorts below its own release, and below a later prerelease.
  assert.equal(compareVersions('4.2.0-rc.1', '4.2.0'), -1);
  assert.equal(compareVersions('4.2.0-rc.2', '4.2.0-rc.10'), -1);
  // Unparsable input means "cannot compare", not "equal".
  assert.equal(compareVersions('4.1.45', 'nightly'), undefined);
});

test('isUpdateCheckDisabled honours our flag and the ecosystem convention', () => {
  assert.equal(isUpdateCheckDisabled({}), false);
  assert.equal(isUpdateCheckDisabled({ AGENTWORKFORCE_NO_UPDATE_CHECK: '1' }), true);
  assert.equal(isUpdateCheckDisabled({ NO_UPDATE_NOTIFIER: '1' }), true);
  assert.equal(isUpdateCheckDisabled({ AGENTWORKFORCE_NO_UPDATE_CHECK: '0' }), false);
});

test('resolveRegistryBase prefers our override, then npm config, then the default', () => {
  assert.equal(resolveRegistryBase({}), DEFAULT_REGISTRY);
  assert.equal(
    resolveRegistryBase({ npm_config_registry: 'https://npm.internal/' }),
    'https://npm.internal'
  );
  assert.equal(
    resolveRegistryBase({
      AGENTWORKFORCE_REGISTRY: 'https://mirror.internal//',
      npm_config_registry: 'https://npm.internal'
    }),
    'https://mirror.internal'
  );
  // A non-http(s) or unparsable registry is ignored rather than fetched.
  assert.equal(resolveRegistryBase({ AGENTWORKFORCE_REGISTRY: 'file:///tmp/reg' }), DEFAULT_REGISTRY);
  assert.equal(resolveRegistryBase({ AGENTWORKFORCE_REGISTRY: 'not a url' }), DEFAULT_REGISTRY);
  assert.equal(resolveRegistryBase({ AGENTWORKFORCE_REGISTRY: '  ' }), DEFAULT_REGISTRY);
});

test('resolveTimeoutMs accepts positive integers only', () => {
  assert.equal(resolveTimeoutMs({}), DEFAULT_UPDATE_CHECK_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ AGENTWORKFORCE_UPDATE_CHECK_TIMEOUT_MS: '250' }), 250);
  assert.equal(
    resolveTimeoutMs({ AGENTWORKFORCE_UPDATE_CHECK_TIMEOUT_MS: '0' }),
    DEFAULT_UPDATE_CHECK_TIMEOUT_MS
  );
  assert.equal(
    resolveTimeoutMs({ AGENTWORKFORCE_UPDATE_CHECK_TIMEOUT_MS: 'soon' }),
    DEFAULT_UPDATE_CHECK_TIMEOUT_MS
  );
});

test('fetchLatestVersion reads the dist-tags endpoint, not the full packument', async () => {
  const { impl, calls } = stubFetch({ latest: '4.2.0', next: '4.3.0-rc.1' });
  const latest = await fetchLatestVersion({ registry: 'https://npm.internal', fetchImpl: impl });
  assert.equal(latest, '4.2.0');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://npm.internal/-/package/agentworkforce/dist-tags');
});

test('fetchLatestVersion swallows registry failures', async () => {
  const notFound = stubFetch({ latest: '4.2.0' }, { ok: false, status: 404 });
  assert.equal(await fetchLatestVersion({ fetchImpl: notFound.impl }), undefined);

  const nonJson = stubFetch('<html>proxy error</html>');
  assert.equal(await fetchLatestVersion({ fetchImpl: nonJson.impl }), undefined);

  const garbage = stubFetch({ latest: 'nightly' });
  assert.equal(await fetchLatestVersion({ fetchImpl: garbage.impl }), undefined);

  const empty = stubFetch(null);
  assert.equal(await fetchLatestVersion({ fetchImpl: empty.impl }), undefined);

  const offline = (async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  }) as unknown as typeof fetch;
  assert.equal(await fetchLatestVersion({ fetchImpl: offline }), undefined);
});

test('fetchLatestVersion gives up once the timeout elapses', async () => {
  const hang = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
  assert.equal(await fetchLatestVersion({ fetchImpl: hang, timeoutMs: 25 }), undefined);
});

test('resolveInstallScope only calls a cwd-local node_modules copy project-scoped', () => {
  const cwd = path.resolve('/work/app');
  const projectModule = pathToFileURL(
    path.join(cwd, 'node_modules', '@agentworkforce', 'cli', 'dist', 'update-check.js')
  ).href;
  const globalModule = pathToFileURL(
    path.resolve('/usr/lib/node_modules/agentworkforce/node_modules/@agentworkforce/cli/dist/update-check.js')
  ).href;
  assert.equal(resolveInstallScope(projectModule, cwd), 'project');
  assert.equal(resolveInstallScope(globalModule, cwd), 'global');
  // A sibling directory that merely shares a prefix is not inside the project.
  assert.equal(resolveInstallScope(globalModule, path.resolve('/work/app-2')), 'global');
  assert.equal(resolveInstallScope('not-a-url', cwd), 'global');
});

test('resolveUpdateCommand drops -g for a project-local install', () => {
  assert.equal(resolveUpdateCommand('global'), 'npm install -g agentworkforce@latest');
  assert.equal(resolveUpdateCommand('project'), 'npm install agentworkforce@latest');
});

test('formatUpdateNotice names both versions and the exact command', () => {
  assert.equal(
    formatUpdateNotice('4.1.45', '4.2.0'),
    'Update available: 4.1.45 → 4.2.0\nRun `npm install -g agentworkforce@latest` to update.\n'
  );
  assert.match(formatUpdateNotice('4.1.45', '4.2.0', 'project'), /npm install agentworkforce@latest/);
});

test('resolveUpdateNotice reports only a genuinely newer published version', async () => {
  const newer = stubFetch({ latest: '4.2.0' });
  assert.match(
    (await resolveUpdateNotice('4.1.45', { env: {}, fetchImpl: newer.impl, scope: 'global' })) ?? '',
    /Update available: 4\.1\.45 → 4\.2\.0/
  );

  const current = stubFetch({ latest: '4.1.45' });
  assert.equal(await resolveUpdateNotice('4.1.45', { env: {}, fetchImpl: current.impl }), undefined);

  // An unreleased local build is ahead of `latest`; it is not out of date.
  const behind = stubFetch({ latest: '4.1.45' });
  assert.equal(await resolveUpdateNotice('4.2.0', { env: {}, fetchImpl: behind.impl }), undefined);

  // A prerelease is behind its own release.
  const release = stubFetch({ latest: '4.2.0' });
  assert.match(
    (await resolveUpdateNotice('4.2.0-rc.1', { env: {}, fetchImpl: release.impl })) ?? '',
    /4\.2\.0-rc\.1 → 4\.2\.0/
  );
});

test('resolveUpdateNotice never touches the network when opted out', async () => {
  const stub = stubFetch({ latest: '99.0.0' });
  assert.equal(
    await resolveUpdateNotice('4.1.45', {
      env: { AGENTWORKFORCE_NO_UPDATE_CHECK: '1' },
      fetchImpl: stub.impl
    }),
    undefined
  );
  assert.equal(stub.calls.length, 0);
});

test('resolveUpdateNotice skips the check for an unparsable running version', async () => {
  const stub = stubFetch({ latest: '99.0.0' });
  assert.equal(await resolveUpdateNotice('dev', { env: {}, fetchImpl: stub.impl }), undefined);
  assert.equal(stub.calls.length, 0);
});

test('resolveUpdateNotice routes through the configured registry', async () => {
  const stub = stubFetch({ latest: '4.2.0' });
  await resolveUpdateNotice('4.1.45', {
    env: { AGENTWORKFORCE_REGISTRY: 'https://mirror.internal' },
    fetchImpl: stub.impl
  });
  assert.equal(stub.calls[0].url, 'https://mirror.internal/-/package/agentworkforce/dist-tags');
});

test('writeUpdateNotice writes the notice and stays silent otherwise', async () => {
  const written: string[] = [];
  const newer = stubFetch({ latest: '4.2.0' });
  await writeUpdateNotice('4.1.45', {
    env: {},
    fetchImpl: newer.impl,
    scope: 'global',
    write: (text) => written.push(text)
  });
  assert.equal(written.length, 1);
  assert.match(written[0], /npm install -g agentworkforce@latest/);

  const current = stubFetch({ latest: '4.1.45' });
  await writeUpdateNotice('4.1.45', {
    env: {},
    fetchImpl: current.impl,
    write: (text) => written.push(text)
  });
  assert.equal(written.length, 1);
});

test('writeUpdateNotice swallows a writer that throws', async () => {
  const newer = stubFetch({ latest: '4.2.0' });
  await writeUpdateNotice('4.1.45', {
    env: {},
    fetchImpl: newer.impl,
    write: () => {
      throw new Error('EPIPE');
    }
  });
});
