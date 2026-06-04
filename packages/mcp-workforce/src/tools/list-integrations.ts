import {
  listIntegrations,
  type IntegrationsDocument
} from '@agentworkforce/deploy';
import type { WorkforceMcpConfig } from '../config.js';

export interface ListIntegrationsArgs {
  provider?: string;
  includeTriggers?: boolean;
}

export interface ListIntegrationsDeps {
  config: WorkforceMcpConfig;
  fetchImpl?: typeof fetch;
  listIntegrations?: typeof listIntegrations;
}

export async function listIntegrationsTool(
  args: ListIntegrationsArgs,
  deps: ListIntegrationsDeps
): Promise<IntegrationsDocument> {
  return await (deps.listIntegrations ?? listIntegrations)({
    workspaceId: deps.config.workspaceId,
    cloudUrl: deps.config.cloudUrl,
    ...(deps.config.runtimeToken ? { token: deps.config.runtimeToken } : {}),
    ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
    ...(args.provider ? { provider: args.provider } : {}),
    includeTriggers: args.includeTriggers !== false,
    activeWorkspace: null,
    async resolveWorkspaceToken() {
      throw new Error('mcp-workforce has no runtime token');
    }
  });
}
