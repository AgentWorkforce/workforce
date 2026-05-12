import type { DeployIO } from './types.js';

/**
 * Workspace authentication primitives. The CLI layer plugs in real
 * implementations that talk to relayauth + the workforce cloud API; the
 * deploy package itself stays SDK-free so the contract is easy to mock.
 */
export interface WorkspaceAuth {
  /** Resolve the active workspace, prompting the user to pick one if needed. */
  resolveWorkspace(args: { override?: string; io: DeployIO }): Promise<{
    workspace: string;
    /** Workspace-scoped token usable for gateway + cloud API calls. */
    token: string;
  }>;
}

/**
 * Environment-backed fallback resolver: reads `WORKFORCE_WORKSPACE_ID`
 * and `WORKFORCE_WORKSPACE_TOKEN` from `process.env`. Useful in CI and as
 * a sane default before the CLI wires up the OAuth flow.
 */
export function envWorkspaceAuth(): WorkspaceAuth {
  return {
    async resolveWorkspace({ override, io }) {
      const workspace = override ?? process.env.WORKFORCE_WORKSPACE_ID;
      const token = process.env.WORKFORCE_WORKSPACE_TOKEN;
      if (!workspace) {
        io.error(
          'no workspace resolved: pass --workspace, set WORKFORCE_WORKSPACE_ID, or run `workforce login`'
        );
        throw new Error('workspace is required for deploy');
      }
      if (!token) {
        io.error(
          'no workspace token resolved: set WORKFORCE_WORKSPACE_TOKEN, or run `workforce login` to mint one'
        );
        throw new Error('workspace token is required for deploy');
      }
      return { workspace, token };
    }
  };
}
