import assert from 'node:assert/strict';
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
  const runtime = new MockNotionEssayRuntime();
  await runtime.spawnAndDispatch(notionEssayPr);

  assert.equal(runtime.sandboxSpawned, true);
  assert.equal(runtime.files.get('/workspace/AGENTS.md'), '# Agent: notion-essay-pr\n');
  assert.deepEqual(runtime.fileReads, ['/notion/pages/page-123.md']);
  assert.equal(runtime.files.get('/workspace/output/page-123.md'), '# A useful essay\n\nDraft body.\n');
  assert.equal(runtime.githubPullRequests.length, 1);
  assert.deepEqual(runtime.githubPullRequests[0], {
    owner: 'AgentWorkforce',
    repo: 'proactive-agents',
    title: 'Essay: Launch notes',
    body: 'Drafted from Notion page page-123.\n\nOutput: /workspace/output/page-123.md',
    head: 'essay/page-123',
    base: 'main',
    files: {
      'output/page-123.md': '# A useful essay\n\nDraft body.\n'
    }
  });
  assert.deepEqual(runtime.memorySaves, [
    {
      content: 'Notion essay PR opened for Launch notes: https://github.com/AgentWorkforce/proactive-agents/pull/17',
      scope: 'workspace',
      tags: ['notion-essay-pr', 'page:page-123']
    }
  ]);
}
);

class MockNotionEssayRuntime {
  readonly files = new Map<string, string>([
    ['/notion/pages/page-123.md', '# Launch notes\n\nWe shipped the first customer-facing deploy path.']
  ]);
  readonly fileReads: string[] = [];
  readonly githubPullRequests: Array<Record<string, unknown>> = [];
  readonly memorySaves: Array<{ content: string; scope?: string; tags?: string[] }> = [];
  sandboxSpawned = false;

  async spawnAndDispatch(handler: (ctx: WorkforceCtx, event: WorkforceProviderEvent) => Promise<void> | void): Promise<void> {
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
        readFile: (path) => this.read(path),
        writeFile: (path, contents) => this.write(path, contents)
      },
      files: {
        read: (path) => this.read(path),
        write: (path, contents) => this.write(path, contents)
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
      log: () => undefined,
      github: {
        comment: async () => ({ id: 'comment-1', url: 'https://example.test/comment' }),
        createIssue: async () => ({ number: 1, url: 'https://example.test/issue' }),
        upsertIssue: async () => ({ number: 1, url: 'https://example.test/issue', created: true }),
        getPr: async () => ({ title: '', body: '', diff: '', head: '', base: '', author: '' }),
        postReview: async () => undefined,
        createPullRequest: async (args) => {
          this.githubPullRequests.push(args);
          return { number: 17, url: 'https://github.com/AgentWorkforce/proactive-agents/pull/17' };
        }
      }
    };
  }

  private async read(path: string): Promise<string> {
    this.fileReads.push(path);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`missing file: ${path}`);
    return value;
  }

  private async write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }
}
