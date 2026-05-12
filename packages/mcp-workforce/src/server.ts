import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, type WorkforceMcpConfig } from './config.js';
import { memoryRecall, memorySave } from './tools/memory.js';
import { workflowRun, workflowStatus } from './tools/workflow.js';
import {
  dispatchIntegration,
  INTEGRATION_TOOL_NAMES,
  type IntegrationToolName
} from './tools/integrations.js';

const MEMORY_SCOPE_ENUM = z.enum(['session', 'user', 'workspace', 'org', 'object']);

/**
 * Build an `McpServer` with workforce-flavored tools registered. Exposed
 * separately from the bin entry so tests can drive the server in-process
 * without piping stdio.
 */
export function createWorkforceMcpServer(config: WorkforceMcpConfig): McpServer {
  const server = new McpServer(
    { name: '@agentworkforce/mcp-workforce', version: '0.0.0' },
    { capabilities: { tools: {} } }
  );

  // ─── workflow.* ──────────────────────────────────────────────────────
  server.registerTool(
    'workflow.run',
    {
      title: 'Run a workforce cloud workflow',
      description:
        'Invoke a named workflow against the active workspace and return the run id + initial status. Long-running workflows are polled via workflow.status.',
      inputSchema: {
        name: z.string().min(1),
        args: z.record(z.string(), z.unknown()).optional()
      }
    },
    async (args) => {
      const result = await workflowRun({ name: args.name, args: args.args }, { config });
      return jsonResult(result);
    }
  );

  server.registerTool(
    'workflow.status',
    {
      title: 'Get workflow run status',
      description: 'Poll a previously-started workflow run for status, output, and error fields.',
      inputSchema: {
        runId: z.string().min(1)
      }
    },
    async (args) => {
      const result = await workflowStatus({ runId: args.runId }, { config });
      return jsonResult(result);
    }
  );

  // ─── memory.* ────────────────────────────────────────────────────────
  server.registerTool(
    'memory.save',
    {
      title: 'Save a memory entry',
      description:
        'Persist a memory entry for the active workspace. Scopes follow @agent-assistant/memory semantics: session, user, workspace, org, object. Tags are deduped; workspace/scope tags are added automatically.',
      inputSchema: {
        content: z.string().min(1),
        tags: z.array(z.string()).optional(),
        scope: MEMORY_SCOPE_ENUM.optional()
      }
    },
    async (args) => {
      const result = await memorySave(args, { config });
      return jsonResult(result);
    }
  );

  server.registerTool(
    'memory.recall',
    {
      title: 'Search memory',
      description:
        'Semantic search over the workspace memory bag. Returns up to `limit` items (default 5, max 50).',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional()
      }
    },
    async (args) => {
      const result = await memoryRecall(args, { config });
      return jsonResult(result);
    }
  );

  // ─── integration.* ───────────────────────────────────────────────────
  // We register a typed schema per integration method instead of a single
  // generic dispatcher so the MCP client gets useful tool descriptions
  // and parameter hints. The runtime delegate is a thin wrapper that
  // dispatches to the per-provider client.
  registerGithubTools(server, config);

  return server;
}

function registerGithubTools(server: McpServer, config: WorkforceMcpConfig): void {
  const targetSchema = {
    target: z.object({
      owner: z.string().min(1),
      repo: z.string().min(1),
      number: z.number().int().positive()
    })
  } as const;

  const repoCoordsSchema = {
    owner: z.string().min(1),
    repo: z.string().min(1)
  } as const;

  server.registerTool(
    'integration.github.comment',
    {
      title: 'Comment on a GitHub issue or PR',
      description: 'Posts a comment on the target issue/PR. Returns the comment URL.',
      inputSchema: {
        ...targetSchema,
        body: z.string().min(1)
      }
    },
    async (args) => jsonResult(await dispatchIntegration('integration.github.comment', args, { config }))
  );

  server.registerTool(
    'integration.github.createIssue',
    {
      title: 'Create a GitHub issue',
      description: 'Creates a new issue in the target repo. Returns { number, url }.',
      inputSchema: {
        ...repoCoordsSchema,
        title: z.string().min(1),
        body: z.string().min(1),
        labels: z.array(z.string()).optional()
      }
    },
    async (args) =>
      jsonResult(await dispatchIntegration('integration.github.createIssue', args, { config }))
  );

  server.registerTool(
    'integration.github.upsertIssue',
    {
      title: 'Upsert a GitHub issue by title match',
      description:
        'Updates an open issue matching `matchTitle` if present, otherwise creates one. Returns { number, url, created }.',
      inputSchema: {
        ...repoCoordsSchema,
        title: z.string().min(1),
        body: z.string().min(1),
        matchTitle: z.string().min(1),
        labels: z.array(z.string()).optional()
      }
    },
    async (args) =>
      jsonResult(await dispatchIntegration('integration.github.upsertIssue', args, { config }))
  );

  server.registerTool(
    'integration.github.getPr',
    {
      title: 'Fetch a GitHub PR with diff',
      description:
        'Returns title, body, head/base refs, author, and the full unified diff via the canonical API endpoint.',
      inputSchema: {
        ...targetSchema
      }
    },
    async (args) => jsonResult(await dispatchIntegration('integration.github.getPr', args, { config }))
  );

  server.registerTool(
    'integration.github.postReview',
    {
      title: 'Post a PR review',
      description:
        'Posts a review with optional inline comments. `event` is one of COMMENT, APPROVE, REQUEST_CHANGES.',
      inputSchema: {
        ...targetSchema,
        review: z.object({
          body: z.string().min(1),
          event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']),
          comments: z
            .array(
              z.object({
                path: z.string().min(1),
                line: z.number().int().positive(),
                body: z.string().min(1)
              })
            )
            .optional()
        })
      }
    },
    async (args) =>
      jsonResult(await dispatchIntegration('integration.github.postReview', args, { config }))
  );
}

/**
 * Wrap a tool's return value in the MCP `CallToolResult` shape. We use
 * JSON-text encoding so any client can read it; structured-output schemas
 * are a follow-up if real consumers want them.
 */
function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }>; [key: string]: unknown } {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value)
      }
    ]
  };
}

/** Server lifetime helper for the bin entry. */
export async function runStdioServer(config: WorkforceMcpConfig = loadConfig()): Promise<void> {
  const server = createWorkforceMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Re-exported for callers wanting the typed integration name list. */
export { INTEGRATION_TOOL_NAMES, type IntegrationToolName };
