import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { extractAgentSpec } from '@agentworkforce/deploy';
import type {
  HarnessRunArgs,
  WorkforceCtx,
  WorkforceEvent,
  WritebackResult
} from '@agentworkforce/runtime';
import {
  defineReviewAgent,
  defineReviewPersona,
  prDiff,
  readPullRequest,
  reviewBody,
  reviewInput
} from './index.js';
import { createReviewHandler } from './agent.js';
import type { ReviewEvidenceProvider } from './types.js';

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const REPO = 'AgentWorkforce/workforce' as const;
const CHARTER = '.agentworkforce/workforce/personas/maintainability.md';
const evidence: ReviewEvidenceProvider<'test-evidence'> = {
  name: 'test-evidence',
  collect: () => ({ title: 'Test evidence', prompt: 'Inspect the supplied fixture.' })
};

test('trap 1: reads the flattened production PR shape even when pull_request is links-only', () => {
  assert.deepEqual(
    readPullRequest({
      number: 281,
      title: 'Ship review-kit',
      draft: false,
      labels: [{ name: 'review' }],
      head: { sha: HEAD_SHA },
      repository: {
        name: 'workforce',
        owner: { login: 'AgentWorkforce' }
      },
      pull_request: {
        url: 'https://api.github.com/repos/AgentWorkforce/workforce/pulls/281'
      }
    }),
    {
      owner: 'AgentWorkforce',
      repo: 'workforce',
      number: 281,
      title: 'Ship review-kit',
      draft: false,
      labels: ['review'],
      headSha: HEAD_SHA
    }
  );
});

test('trap 1 compatibility: reads raw nested and normalized Relayfile PR shapes', () => {
  assert.equal(
    readPullRequest({
      repository: { full_name: REPO },
      pull_request: { number: 11, title: 'Nested', head: { sha: HEAD_SHA } }
    })?.number,
    11
  );
  assert.deepEqual(
    readPullRequest({
      provider: 'github',
      objectType: 'pull_request',
      objectId: '12',
      payload: {
        title: 'Normalized',
        url: 'https://api.github.com/repos/AgentWorkforce/workforce/pulls/12',
        head_sha: HEAD_SHA
      }
    }),
    {
      owner: 'AgentWorkforce',
      repo: 'workforce',
      number: 12,
      title: 'Normalized',
      draft: false,
      labels: [],
      headSha: HEAD_SHA
    }
  );
});

test('traps 2–4: deploy extraction keeps concrete pulls/issues paths and emits no where rule', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-kit-extract-'));
  try {
    const entry = join(root, 'agent.ts');
    const reviewKitEntry = new URL('./index.js', import.meta.url).pathname;
    await writeFile(
      entry,
      [
        `import { defineReviewAgent, defineReviewEvidence } from '${reviewKitEntry}';`,
        'export default defineReviewAgent({',
        `  repo: '${REPO}',`,
        `  charter: '${CHARTER}',`,
        "  lens: 'maintainability',",
        "  evidence: [defineReviewEvidence({ name: 'test', collect: () => ({ title: 'x', prompt: 'x' }) })]",
        '});'
      ].join('\n'),
      'utf8'
    );
    const { agent } = await extractAgentSpec(entry);
    const triggers = agent.triggers?.github;
    assert.equal(triggers?.length, 2);
    for (const trigger of triggers ?? []) {
      assert.deepEqual(trigger.paths, [
        '/github/repos/AgentWorkforce/workforce/pulls/**',
        '/github/repos/AgentWorkforce/workforce/issues/**'
      ]);
      assert.equal(trigger.where, undefined);
      assert.equal(trigger.maxConcurrency, 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trap 3: factory mounts issue comments as well as pull metadata', () => {
  const agent = defineReviewAgent({
    repo: REPO,
    charter: CHARTER,
    lens: 'maintainability',
    evidence: [evidence]
  });
  assert.deepEqual(agent.triggers?.github?.[0]?.paths, [
    '/github/repos/AgentWorkforce/workforce/pulls/**',
    '/github/repos/AgentWorkforce/workforce/issues/**'
  ]);
});

test('trap 5: persona is read-only while enabling the post-cloud#2664 PR checkout capability', () => {
  const persona = defineReviewPersona({
    repo: REPO,
    lens: 'maintainability',
    systemPrompt: 'Review maintainability.',
    fetchDepth: 'full'
  });
  assert.deepEqual(persona.capabilities.pullRequest, {
    enabled: true,
    writeback: false,
    fetchDepth: 'full'
  });
  assert.deepEqual(persona.integrations.github.scope, { repo: REPO });
  assert.equal(persona.sandbox, true);
  assert.equal('memory' in persona, false);
});

test('trap 5 symptom: PR-diff evidence rejects a silent zero-byte checkout', async () => {
  const provider = prDiff();
  const ctx = {
    sandbox: {
      cwd: '/workspace',
      readFile: async () => ''
    }
  } as unknown as WorkforceCtx;
  await assert.rejects(
    () =>
      Promise.resolve(provider.collect({
        ctx,
        pullRequest: {
          owner: 'AgentWorkforce',
          repo: 'workforce',
          number: 281,
          title: 'Review kit',
          draft: false,
          labels: [],
          headSha: HEAD_SHA
        },
        payload: {},
        charterPath: CHARTER
      })),
    /review evidence \.workforce\/pr\.diff is empty/
  );
});

test('trap 6: a missing writeback receipt is logged as unconfirmed and never thrown', async () => {
  const fixture = handlerFixture();
  await assert.doesNotReject(() => fixture.handler(fixture.ctx, fixture.event));
  assert.equal(fixture.writes.length, 1);
  assert.equal(
    fixture.logs.some((entry) => entry.message === 'review-kit.delivery.unconfirmed'),
    true
  );
});

test('plumbing: repository, label, and draft guards skip before requiring a mount', async () => {
  const handler = createReviewHandler({
    repo: REPO,
    charter: CHARTER,
    lens: 'maintainability',
    evidence: [evidence]
  });
  const repoFixture = handlerFixture();
  await withRelayfileTransportEnv({}, () =>
    handler(
      repoFixture.ctx,
      repoFixture.eventForData({
        number: 281,
        title: 'Wrong repository',
        repository: { full_name: 'elsewhere/workforce' },
        head: { sha: HEAD_SHA }
      })
    )
  );
  assert.equal(repoFixture.harnessRuns(), 0);
  assert.equal(repoFixture.writes.length, 0);
  assert.equal(repoFixture.logs.at(-1)?.fields?.reason, 'different-repository');

  const labelFixture = handlerFixture();
  await withRelayfileTransportEnv({}, () =>
    handler(
      labelFixture.ctx,
      labelFixture.eventForData({
        number: 281,
        title: 'Skipped by root label',
        repository: { full_name: REPO },
        labels: [{ name: 'no-maintainability-review' }],
        head: { sha: HEAD_SHA }
      })
    )
  );
  assert.equal(labelFixture.harnessRuns(), 0);
  assert.equal(labelFixture.logs.at(-1)?.fields?.reason, 'label:no-maintainability-review');

  const draftFixture = handlerFixture();
  await withRelayfileTransportEnv({}, () =>
    handler(
      draftFixture.ctx,
      draftFixture.eventForData({
        number: 281,
        title: 'Draft review',
        draft: true,
        repository: { full_name: REPO },
        head: { sha: HEAD_SHA }
      })
    )
  );
  assert.equal(draftFixture.harnessRuns(), 0);
  assert.equal(draftFixture.logs.at(-1)?.fields?.reason, 'draft');
});

test('plumbing: absent root labels fail open and run the review', async () => {
  const fixture = handlerFixture();
  await fixture.handler(fixture.ctx, fixture.event);
  assert.equal(fixture.harnessRuns(), 1);
  assert.equal(fixture.writes.length, 1);
});

test('plumbing: missing and empty charters fail before harness execution', async () => {
  const missing = handlerFixture({ charterContent: null });
  await assert.rejects(() => missing.handler(missing.ctx, missing.event), /review charter is missing/u);
  assert.equal(missing.harnessRuns(), 0);

  const empty = handlerFixture({ charterContent: '  \n' });
  await assert.rejects(() => empty.handler(empty.ctx, empty.event), /review charter .* is empty/u);
  assert.equal(empty.harnessRuns(), 0);
});

test('plumbing: harness receives sandbox cwd and rejects nonzero or empty output', async () => {
  const success = handlerFixture();
  await success.handler(success.ctx, success.event);
  assert.equal(success.harnessArgs[0]?.cwd, '/workspace');

  const nonzero = handlerFixture({ harnessExitCode: 2 });
  await assert.rejects(
    () => nonzero.handler(nonzero.ctx, nonzero.event),
    /review harness failed \(exit 2\)/u
  );
  assert.equal(nonzero.writes.length, 0);

  const empty = handlerFixture({ harnessOutput: '  \n' });
  await assert.rejects(
    () => empty.handler(empty.ctx, empty.event),
    /review harness produced no review/u
  );
  assert.equal(empty.writes.length, 0);
});

test('plumbing: review inputs resolve env, then context, then default', () => {
  const name = 'SKIP_LABELS';
  const env = 'REVIEW_KIT_TEST_SKIP_LABELS';
  const ctx = {
    persona: {
      inputSpecs: {
        [name]: { env, default: 'from-default' }
      },
      inputs: { [name]: 'from-context' }
    }
  } as unknown as WorkforceCtx;
  const previous = process.env[env];
  try {
    process.env[env] = ' from-env ';
    assert.equal(reviewInput(ctx, name), 'from-env');
    delete process.env[env];
    assert.equal(reviewInput(ctx, name), 'from-context');
    delete (ctx.persona.inputs as Record<string, string>)[name];
    assert.equal(reviewInput(ctx, name), 'from-default');
  } finally {
    if (previous === undefined) delete process.env[env];
    else process.env[env] = previous;
  }
});

test('trap 7 transport: direct HTTP is rejected because durable dedupe requires a real mount', async () => {
  const fixture = handlerFixture();
  const requests: string[] = [];
  await withRelayfileTransportEnv(
    {
      RELAYFILE_URL: 'https://relayfile.example.test',
      RELAYFILE_TOKEN: 'test-token',
      RELAYFILE_WORKSPACE_ID: 'workspace-1'
    },
    async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input) => {
        requests.push(String(input));
        return Response.json({
          opId: 'op-review-1',
          status: 'queued',
          targetRevision: 'revision-1',
          writeback: { provider: 'github', state: 'pending' }
        });
      }) as typeof fetch;
      try {
        const handler = createReviewHandler({
          repo: REPO,
          charter: CHARTER,
          lens: 'maintainability',
          evidence: [evidence]
        });
        await assert.rejects(
          () => handler(fixture.ctx, fixture.event),
          /requires a configured Relayfile mount for durable head-SHA idempotency/
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
  assert.equal(requests.length, 0);
  assert.equal(fixture.harnessRuns(), 0);
});

test('trap 7 transport: no mount fails before harness execution instead of dropping a cwd draft', async () => {
  const fixture = handlerFixture();
  await withRelayfileTransportEnv({}, async () => {
    const handler = createReviewHandler({
      repo: REPO,
      charter: CHARTER,
      lens: 'maintainability',
      evidence: [evidence]
    });
    await assert.rejects(
      () => handler(fixture.ctx, fixture.event),
      /requires a configured Relayfile mount for durable head-SHA idempotency/
    );
  });
  assert.equal(fixture.harnessRuns(), 0);
});

test('trap 7 transport: a canonical rename on a real mount dedupes a fresh invocation', async () => {
  const mount = await mkdtemp(join(tmpdir(), 'review-kit-mount-'));
  const fixture = handlerFixture();
  try {
    await withRelayfileTransportEnv({ RELAYFILE_MOUNT_PATH: mount }, async () => {
      const options = {
        repo: REPO,
        charter: CHARTER,
        lens: 'maintainability',
        evidence: [evidence]
      } as const;
      await createReviewHandler(options)(fixture.ctx, fixture.event);

      const comments = join(
        mount,
        'github/repos/AgentWorkforce/workforce/issues/281/comments'
      );
      const [draft] = await readdir(comments);
      assert.match(draft ?? '', /^review-maintainability-/u);
      const canonical = join(comments, '123456789');
      await mkdir(canonical);
      await rename(join(comments, draft!), join(canonical, 'meta.json'));

      await createReviewHandler(options)(fixture.ctx, fixture.event);
    });
    const entries = await readdir(
      join(mount, 'github/repos/AgentWorkforce/workforce/issues/281/comments')
    );
    assert.deepEqual(entries, ['123456789']);
    assert.equal(fixture.harnessRuns(), 1);
  } finally {
    await rm(mount, { recursive: true, force: true });
  }
});

test('trap 7: the head-SHA command key makes a retried delivery idempotent', async () => {
  const fixture = handlerFixture();
  await fixture.handler(fixture.ctx, fixture.event);
  await fixture.handler(fixture.ctx, fixture.event);
  assert.equal(fixture.harnessRuns(), 1);
  assert.equal(fixture.writes.length, 1);
  assert.match(fixture.writes[0]?.path ?? '', new RegExp(`review-maintainability-${HEAD_SHA}\\.json$`, 'u'));
  assert.equal(
    fixture.logs.some(
      (entry) =>
        entry.message === 'review-kit.skipped' && entry.fields?.reason === 'already-reviewed'
    ),
    true
  );
});

test('trap 7: a confirmed canonical comment marker dedupes a fresh retry, while a new SHA posts', async () => {
  const fixture = handlerFixture();
  await fixture.handler(fixture.ctx, fixture.event);
  fixture.canonicalizeLastWrite('123456789');

  const freshHandler = fixture.newHandler();
  await freshHandler(fixture.ctx, fixture.event);
  assert.equal(fixture.harnessRuns(), 1);
  assert.equal(fixture.writes.length, 1);

  const nextSha = 'abcdef0123456789abcdef0123456789abcdef01';
  await freshHandler(fixture.ctx, fixture.eventForSha(nextSha));
  assert.equal(fixture.harnessRuns(), 2);
  assert.equal(fixture.writes.length, 2);
  assert.match(fixture.writes[1]?.path ?? '', new RegExp(`${nextSha}\\.json$`, 'u'));
});

test('trap 7: a legacy flat canonical comment marker also dedupes a fresh retry', async () => {
  const fixture = handlerFixture();
  await fixture.handler(fixture.ctx, fixture.event);
  fixture.canonicalizeLastWrite('123456789', 'flat');
  await fixture.newHandler()(fixture.ctx, fixture.event);
  assert.equal(fixture.harnessRuns(), 1);
  assert.equal(fixture.writes.length, 1);
});

test('head-SHA fallback fails closed when neither payload nor checkout can identify a revision', async () => {
  const fixture = handlerFixture({ includeHeadSha: false, gitHeadAvailable: false });
  await assert.rejects(
    () => fixture.handler(fixture.ctx, fixture.event),
    /cannot derive a head-SHA idempotency key/
  );
  assert.equal(fixture.writes.length, 0);
});

interface LogEntry {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

interface HandlerFixtureOptions {
  includeHeadSha?: boolean;
  gitHeadAvailable?: boolean;
  charterContent?: string | null;
  harnessExitCode?: number;
  harnessOutput?: string;
}

function handlerFixture(options: HandlerFixtureOptions = {}) {
  const files = new Map<string, string>();
  const writes: Array<{ path: string; body: unknown }> = [];
  const logs: LogEntry[] = [];
  const harnessArgs: HarnessRunArgs[] = [];
  let runCount = 0;
  const newHandler = () =>
    createReviewHandler(
      {
        repo: REPO,
        charter: CHARTER,
        lens: 'maintainability',
        evidence: [evidence]
      },
      {
        client: () => ({ relayfileMountRoot: '/tmp/review-kit-test', writebackTimeoutMs: 0 }),
        readRecord: async (_client, path) => {
          const value = files.get(path);
          if (value === undefined) {
            throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
          }
          return JSON.parse(value) as unknown;
        },
        listEntries: async (_client, directory) => {
          const prefix = `${directory.replace(/\/+$/u, '')}/`;
          return [
            ...new Set(
              [...files.keys()]
                .filter((path) => path.startsWith(prefix))
                .map((path) => path.slice(prefix.length).split('/')[0])
                .filter(Boolean)
            )
          ];
        },
        writeComment: async (_client, _provider, _operation, path, body) => {
          writes.push({ path, body });
          files.set(path, JSON.stringify(body));
          return { path } as WritebackResult;
        }
      }
    );
  const handler = newHandler();
  const ctx = {
    persona: { inputSpecs: {}, inputs: {} },
    sandbox: {
      cwd: '/workspace',
      readFile: async (path: string) => {
        if (path.endsWith(CHARTER)) {
          if (options.charterContent === null) {
            throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
          }
          return options.charterContent ?? 'Review doctrine';
        }
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      },
      exec: async (command: string) => {
        if (command === 'git rev-parse HEAD' && options.gitHeadAvailable !== false) {
          return { exitCode: 0, output: `${HEAD_SHA}\n` };
        }
        return { exitCode: 1, output: '' };
      }
    },
    harness: {
      run: async (args: HarnessRunArgs) => {
        harnessArgs.push(args);
        runCount += 1;
        return {
          exitCode: options.harnessExitCode ?? 0,
          output: options.harnessOutput ?? 'No concerns.',
          stderr: ''
        };
      }
    },
    log: (level: string, message: string, fields?: Record<string, unknown>) => {
      logs.push({ level, message, fields });
    }
  } as unknown as WorkforceCtx;
  const eventForData = (data: Record<string, unknown>) =>
    ({
      type: 'github.pull_request.opened',
      expand: async () => ({ data })
    }) as unknown as WorkforceEvent;
  const eventForSha = (headSha: string | undefined) =>
    eventForData({
      number: 281,
      title: 'Review kit',
      repository: { full_name: REPO },
      ...(headSha === undefined ? {} : { head: { sha: headSha } }),
      pull_request: { url: 'links-only' }
    });
  const event = eventForSha(options.includeHeadSha === false ? undefined : HEAD_SHA);
  const canonicalizeLastWrite = (
    commentId: string,
    shape: 'directory' | 'flat' = 'directory'
  ) => {
    const last = writes.at(-1);
    assert(last, 'expected a write to canonicalize');
    files.delete(last.path);
    const directory = last.path.slice(0, last.path.lastIndexOf('/'));
    const canonicalPath =
      shape === 'directory'
        ? `${directory}/${commentId}/meta.json`
        : `${directory}/${commentId}.json`;
    files.set(canonicalPath, JSON.stringify(last.body));
  };
  return {
    handler,
    newHandler,
    ctx,
    event,
    eventForData,
    eventForSha,
    canonicalizeLastWrite,
    writes,
    logs,
    harnessArgs,
    harnessRuns: () => runCount
  };
}

test('package version constant stays aligned with package.json', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version: string };
  const { REVIEW_KIT_VERSION } = await import('./index.js');
  assert.equal(REVIEW_KIT_VERSION, pkg.version);
});

test('compiled version logging reads the packaged metadata instead of freezing a release literal', async () => {
  const compiled = await readFile(new URL('./agent.js', import.meta.url), 'utf8');
  assert.match(compiled, /from ['"]\.\.\/package\.json['"] with \{ type: ['"]json['"] \}/u);
  assert.doesNotMatch(compiled, /REVIEW_KIT_VERSION\s*=\s*['"]\d/u);
});

test('already-built dist observes a post-build package-version bump', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const staged = await mkdtemp(join(packageRoot, '.version-test-'));
  const sentinelVersion = '99.98.97-version-test';
  try {
    await cp(join(packageRoot, 'dist'), join(staged, 'dist'), { recursive: true });
    await writeFile(
      join(staged, 'package.json'),
      JSON.stringify({ name: '@agentworkforce/review-kit-version-test', type: 'module', version: sentinelVersion }),
      'utf8'
    );
    const built = (await import(
      `${pathToFileURL(join(staged, 'dist/agent.js')).href}?version-test=${Date.now()}`
    )) as { REVIEW_KIT_VERSION: string };
    assert.equal(built.REVIEW_KIT_VERSION, sentinelVersion);
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
});

const RELAYFILE_TRANSPORT_ENV = [
  'RELAYFILE_MOUNT_PATH',
  'WORKSPACE_ROOT',
  'WORKFORCE_SANDBOX_ROOT',
  'RELAYFILE_MOUNT_ROOT',
  'RELAYFILE_ROOT',
  'RELAYFILE_BASE_URL',
  'RELAYFILE_URL',
  'RELAYFILE_TOKEN',
  'RELAYFILE_WORKSPACE_ID',
  'RELAYFILE_WORKSPACE'
] as const;

async function withRelayfileTransportEnv(
  values: Partial<Record<(typeof RELAYFILE_TRANSPORT_ENV)[number], string>>,
  run: () => Promise<void>
): Promise<void> {
  const previous = Object.fromEntries(
    RELAYFILE_TRANSPORT_ENV.map((name) => [name, process.env[name]])
  );
  try {
    for (const name of RELAYFILE_TRANSPORT_ENV) delete process.env[name];
    Object.assign(process.env, values);
    await run();
  } finally {
    for (const name of RELAYFILE_TRANSPORT_ENV) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('reviewBody strips the model preamble and keeps the review', () => {
  // Shape observed in production: the harness stdout carries the model's
  // thinking, then the review. Only the review should reach the PR.
  const output = [
    'Evidence confirmed. The 8 probe commits added only comment lines.',
    'I have all evidence needed. Writing the review now.',
    '',
    '**Verdict: Blocker.** Second stat-math path outside lib/aggregates.ts.',
    '',
    '- **Blocker** — `lib/recentForm.ts:15` — duplicate math. Fix: use computeStandings.'
  ].join('\n');

  const body = reviewBody(output);
  assert.ok(body.startsWith('**Verdict: Blocker.**'), 'must open on the verdict line');
  assert.ok(!body.includes('Evidence confirmed'), 'preamble must be gone');
  assert.ok(!body.includes('Writing the review now'), 'narration must be gone');
  assert.ok(body.includes('lib/recentForm.ts:15'), 'findings must survive');
});

test('reviewBody cuts at the LAST verdict line so a drafted review loses to the real one', () => {
  // A model that drafts before writing emits two verdict lines; the real
  // review is the final one.
  const output = [
    '**Verdict: Note.** draft — I might downgrade this.',
    'Actually, checking the published-only rule changes it.',
    '**Verdict: Blocker.** ignores the published-only filter.'
  ].join('\n');

  assert.equal(reviewBody(output), '**Verdict: Blocker.** ignores the published-only filter.');
});

test('reviewBody passes through a body with no verdict line', () => {
  // The model ignored the format. A malformed review still beats silence —
  // for an advisory agent, silence reads as approval.
  assert.equal(reviewBody('no verdict here, just prose'), 'no verdict here, just prose');
  assert.equal(reviewBody('   '), '');
  assert.equal(reviewBody(''), '');
});
