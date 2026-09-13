import type { DeployIO, ModeLaunchInput } from '../types.js';

export function formatSandboxError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveSandboxAuthMode(
  input: Partial<Pick<ModeLaunchInput, 'workspaceToken'>>,
  { forceByo = false }: { forceByo?: boolean } = {},
): 'byo' | 'managed' {
  const byoAvailable = Boolean(process.env.DAYTONA_API_KEY?.trim() || process.env.DAYTONA_JWT_TOKEN?.trim());
  if (forceByo || byoAvailable) {
    if (!byoAvailable) {
      throw new Error('sandbox launcher: --byo-sandbox requested but no Daytona credentials are in env. Set DAYTONA_API_KEY (or DAYTONA_JWT_TOKEN + DAYTONA_ORGANIZATION_ID).');
    }
    return 'byo';
  }
  if (!(input.workspaceToken?.trim() || process.env.WORKFORCE_WORKSPACE_TOKEN?.trim())) {
    throw new Error('sandbox launcher: no Daytona credentials and no workforce workspace token. Either export DAYTONA_API_KEY, or run `workforce login` (sets WORKFORCE_WORKSPACE_TOKEN) so we can mint a workforce-managed sandbox.');
  }
  return 'managed';
}

export function createIdempotentStop(destroyFn: () => Promise<void>, io: Pick<DeployIO, 'warn'>): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => stopping ??= Promise.resolve().then(destroyFn).catch(err => {
    io.warn(`sandbox: cleanup failed: ${formatSandboxError(err)}`);
  });
}

export async function destroyOnFailure(destroyFn: () => Promise<void>, err: unknown): Promise<never> {
  try { await destroyFn(); } catch { /* Preserve the original launch failure. */ }
  throw err;
}
