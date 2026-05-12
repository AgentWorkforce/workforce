import type { WorkforceMcpConfig } from '../config.js';

/** Public result shape the MCP tool returns. Kept in sync with the workforce cloud workflows REST contract. */
export interface WorkflowRunResult {
  runId: string;
  status: 'pending' | 'running' | 'success' | 'failure';
  output?: unknown;
  error?: string;
}

export interface WorkflowStatusResult {
  status: 'pending' | 'running' | 'success' | 'failure';
  output?: unknown;
  error?: string;
}

export interface WorkflowToolDeps {
  config: WorkforceMcpConfig;
  fetchImpl?: typeof fetch;
}

/**
 * `workflow.run` tool. POSTs a workflow invocation to the workforce cloud
 * workflows API; returns immediately with the run id + initial status.
 * Long-running workflows are polled via `workflow.status`.
 */
export async function workflowRun(
  args: { name: string; args?: Record<string, unknown> },
  deps: WorkflowToolDeps
): Promise<WorkflowRunResult> {
  if (!args.name || !args.name.trim()) {
    throw new Error('workflow.run: "name" is required');
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${deps.config.cloudUrl}/api/v1/workspaces/${encodeURIComponent(
    deps.config.workspaceId
  )}/workflows/run`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: workflowHeaders(deps.config),
    body: JSON.stringify({ name: args.name, args: args.args ?? {} })
  });
  if (!response.ok) {
    throw await toError(response, `workflow.run("${args.name}")`);
  }
  const payload = (await response.json()) as WorkflowRunResult;
  if (!payload?.runId) {
    throw new Error(`workflow.run("${args.name}"): cloud response missing runId`);
  }
  return payload;
}

/** `workflow.status` tool — poll a previously-started run. */
export async function workflowStatus(
  args: { runId: string },
  deps: WorkflowToolDeps
): Promise<WorkflowStatusResult> {
  if (!args.runId || !args.runId.trim()) {
    throw new Error('workflow.status: "runId" is required');
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${deps.config.cloudUrl}/api/v1/workspaces/${encodeURIComponent(
    deps.config.workspaceId
  )}/workflows/runs/${encodeURIComponent(args.runId)}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: workflowHeaders(deps.config)
  });
  if (!response.ok) {
    throw await toError(response, `workflow.status("${args.runId}")`);
  }
  return (await response.json()) as WorkflowStatusResult;
}

function workflowHeaders(config: WorkforceMcpConfig): Record<string, string> {
  if (!config.runtimeToken) {
    throw new Error(
      'workflow tool requires WORKFORCE_RUNTIME_TOKEN in the env; the runtime injects this when it spawns the harness'
    );
  }
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${config.runtimeToken}`,
    'user-agent': 'mcp-workforce'
  };
}

async function toError(response: Response, label: string): Promise<Error> {
  const body = await response.text().catch(() => '');
  const excerpt = body.length > 400 ? `${body.slice(0, 400)}…` : body;
  return new Error(
    `${label}: ${response.status} ${response.statusText}${excerpt ? ` — ${excerpt}` : ''}`
  );
}
