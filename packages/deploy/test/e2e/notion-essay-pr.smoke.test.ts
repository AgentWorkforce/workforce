import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as notionEssayPrModule from '../../../../examples/notion-essay-pr/agent.js';
import type { WorkforceCtx, WorkforceProviderEvent } from '@agentworkforce/runtime';

type NotionEssayHandler = (ctx: WorkforceCtx, event: WorkforceProviderEvent) => Promise<void> | void;

const notionEssayPr = resolveHandler(notionEssayPrModule);

function resolveHandler(moduleValue: unknown): NotionEssayHandler {
  const firstDefault = (moduleValue as { default?: unknown }).default;
  if (typeof firstDefault === 'function') return firstDefault as NotionEssayHandler;
  const nestedDefault = (firstDefault as { default?: unknown } | undefined)?.default;
  if (typeof nestedDefault === 'function') return nestedDefault as NotionEssayHandler;
  throw new TypeError('notion-essay-pr smoke could not resolve the example handler default export');
}

test('notion-essay-pr e2e smoke runs a Notion page event to an essay PR with mocks', async () => {
  const runtime = await MockNotionEssayRuntime.create();
  try {
    await runtime.spawnAndDispatch(notionEssayPr);

    assert.equal(runtime.sandboxSpawned, true);
    assert.equal(runtime.files.get('/workspace/AGENTS.md'), '# Agent: notion-essay-pr\n');
    assert.deepEqual(runtime.fileReads, ['/notion/pages/page-123.md']);
    assert.equal(runtime.files.get('/workspace/output/page-123.md'), '# A useful essay\n\nDraft body.\n');

    const writebacks = await runtime.collectPullRequestWritebacks();
    assert.equal(writebacks.length, 1);
    assert.deepEqual(writebacks[0], {
      title: 'Essay: Launch notes',
      body: 'Drafted from Notion page page-123.\n\nOutput: /workspace/output/page-123.md',
      head: 'essay/page-123',
      base: 'main',
      files: {
        'output/page-123.md': '# A useful essay\n\nDraft body.\n'
      }
    });

    assert.equal(runtime.memorySaves.length, 1);
    const save = runtime.memorySaves[0]!;
    assert.match(save.content, /^Notion essay PR opened for Launch notes: /);
    assert.equal(save.scope, 'workspace');
    assert.deepEqual(save.tags, ['notion-essay-pr', 'page:page-123']);
  } finally {
    delete process.env.RELAYFILE_MOUNT_ROOT;
  }
});

class MockNotionEssayRuntime {
  readonly files = new Map<string, string>([
    ['/notion/pages/page-123.md', '# Launch notes\n\nWe shipped the first customer-facing deploy path.']
  ]);
  readonly fileReads: string[] = [];
  readonly memorySaves: Array<{ content: string; scope?: string; tags?: string[] }> = [];
  sandboxSpawned = false;

  readonly relayfileRoot: string;

  static async create(): Promise<MockNotionEssayRuntime> {
    const root = await mkdtemp(path.join(tmpdir(), 'notion-essay-pr-e2e-'));
    process.env.RELAYFILE_MOUNT_ROOT = root;
    return new MockNotionEssayRuntime(root);
  }

  private constructor(relayfileRoot: string) {
    this.relayfileRoot = relayfileRoot;
  }

  async spawnAndDispatch(handler: NotionEssayHandler): Promise<void> {
    this.sandboxSpawned = true;
    this.files.set('/workspace/AGENTS.md', '# Agent: notion-essay-pr\n');
    await handler(this.ctx(), {
      id: 'evt-page-123',
      source: 'notion',
      type: 'page.created',
      workspaceId: 'ws-proactive',
      occurredAt: '2026-05-13T12:00:00.000Z',
      attempt: 1,
      payload: {
        pageId: 'page-123',
        title: 'Launch notes'
      },
      summary: {
        title: 'Launch notes'
      }
    });
  }

  async collectPullRequestWritebacks(): Promise<Array<Record<string, unknown>>> {
    const dir = path.join(
      this.relayfileRoot,
      'github',
      'repos',
      'AgentWorkforce',
      'proactive-agents',
      'pulls'
    );
    const entries = await readdir(dir).catch(() => []);
    const out: Array<Record<string, unknown>> = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const body = JSON.parse(await readFile(path.join(dir, entry), 'utf8')) as Record<string, unknown>;
      out.push(body);
    }
    return out;
  }

  private ctx(): WorkforceCtx {
    return {
      persona: {
        id: 'notion-essay-pr',
        intent: 'documentation',
        tags: ['documentation', 'release'],
        description: 'fixture',
        skills: [],
        harness: 'claude',
        model: 'claude-sonnet-4-6',
        systemPrompt: '',
        harnessSettings: { reasoning: 'medium', timeoutSeconds: 600 },
        inputs: { GITHUB_TARGET_REPO: 'AgentWorkforce/proactive-agents' },
        inputSpecs: {}
      },
      agent: { id: 'agent-1', deployedName: 'notion-essay-pr', spawnedByAgentId: null },
      deployment: { id: 'deployment-1', triggerKind: 'radio', parentDeploymentId: null },
      workspaceId: 'ws-proactive',
      agentName: 'notion-essay-pr',
      llm: {
        async complete() {
          return '';
        }
      },
      harness: {
        async run() {
          return { output: '# A useful essay\n\nDraft body.', exitCode: 0, durationMs: 25 };
        }
      },
      sandbox: {
        cwd: '/workspace',
        async exec() {
          return { output: '', exitCode: 0 };
        },
        readFile: (filePath) => this.read(filePath),
        writeFile: (filePath, contents) => this.write(filePath, contents)
      },
      files: {
        read: (filePath) => this.read(filePath),
        write: (filePath, contents) => this.write(filePath, contents)
      },
      memory: {
        async recall() {
          return [{
            id: 'mem-1',
            content: 'Previous essays should be concise.',
            tags: ['notion-essay-pr'],
            scope: 'workspace',
            createdAt: '2026-05-13T10:00:00.000Z'
          }];
        },
        save: async (content, opts) => {
          this.memorySaves.push({ content, scope: opts?.scope, tags: opts?.tags });
          return { id: 'mem-2' };
        }
      },
      workflow: {
        async run() {
          throw new Error('not configured');
        },
        async status() {
          throw new Error('not configured');
        }
      },
      schedule: {
        async at() {
          /* unused */
        },
        async cancel() {
          /* unused */
        }
      },
      log: () => undefined
    };
  }

  private async read(filePath: string): Promise<string> {
    this.fileReads.push(filePath);
    const value = this.files.get(filePath);
    if (value === undefined) throw new Error(`missing file: ${filePath}`);
    return value;
  }

  private async write(filePath: string, contents: string): Promise<void> {
    this.files.set(filePath, contents);
    if (filePath.startsWith('/workspace/')) {
      const target = path.join(this.relayfileRoot, filePath.replace(/^\//, ''));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, 'utf8');
    }
  }
}
