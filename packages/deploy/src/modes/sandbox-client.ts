import { readFile } from 'node:fs/promises';
import { Daytona, type Sandbox as DaytonaSandbox } from '@daytonaio/sdk';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import type { BundleResult } from '../types.js';

type PersonaIntegrations = NonNullable<PersonaSpec['integrations']>;

/**
 * Working directory the runner is invoked from inside the sandbox. Same
 * mount root cloud's DaytonaRuntime defaults to, so persona authors get
 * consistent paths whether they run under workforce or cloud workflows.
 */
export const SANDBOX_BUNDLE_DIR = '/home/daytona/bundle';

export interface SandboxExecResult {
  exitCode: number;
  output: string;
}

/**
 * Abstraction over the two paths workforce uses to drive a sandbox:
 *   - BYO  — the user's `DAYTONA_API_KEY` is in env; we talk to Daytona
 *            directly via the SDK.
 *   - Proxy — workforce cloud holds the org Daytona credentials; we
 *            POST `/workspaces/:id/sandboxes` to mint a sandbox and then
 *            send `exec` and `files` calls through cloud's per-sandbox
 *            proxy URLs.
 *
 * Both implementations satisfy the same interface so the launcher stays
 * mode-agnostic. `mint()` is required up front; the rest of the methods
 * operate on the returned handle.
 */
export interface SandboxClient {
  mint(args: MintArgs): Promise<SandboxHandle>;
  uploadBundle(handle: SandboxHandle, bundle: BundleResult): Promise<void>;
  exec(handle: SandboxHandle, command: string, opts?: ExecOptions): Promise<SandboxExecResult>;
  destroy(handle: SandboxHandle): Promise<void>;
}

export interface MintArgs {
  label: string;
  env?: Record<string, string>;
  integrations?: PersonaIntegrations;
  /** Cap the create call itself; not the sandbox lifetime. */
  createTimeoutSeconds?: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface SandboxHandle {
  /** Mode-tagged id (`byo:<sandboxId>` / `proxy:<sandboxId>`). */
  id: string;
  sandboxId: string;
  mode: 'byo' | 'proxy';
}

// ─── BYO: direct Daytona SDK ────────────────────────────────────────────

export interface ByoSandboxClientOptions {
  apiKey?: string;
  jwtToken?: string;
  organizationId?: string;
}

interface ByoHandleInternal extends SandboxHandle {
  mode: 'byo';
  sandbox: DaytonaSandbox;
}

export function createByoSandboxClient(opts: ByoSandboxClientOptions): SandboxClient {
  if (!opts.apiKey && !opts.jwtToken) {
    throw new Error(
      'BYO sandbox client requires DAYTONA_API_KEY (or DAYTONA_JWT_TOKEN + DAYTONA_ORGANIZATION_ID) in env'
    );
  }
  const daytona = new Daytona(opts);

  return {
    async mint(args) {
      const sandbox = await daytona.create({
        language: 'typescript',
        name: args.label,
        ...(args.env ? { envVars: args.env } : {})
      });
      const handle: ByoHandleInternal = {
        id: `byo:${sandbox.id}`,
        sandboxId: sandbox.id,
        mode: 'byo',
        sandbox
      };
      return handle;
    },
    async uploadBundle(handle, bundle) {
      const internal = handle as ByoHandleInternal;
      const files = await readBundleFiles(bundle);
      await internal.sandbox.fs.uploadFiles(files);
      // Same offline-friendly npm install pattern as the proxy path so
      // the bundle's runtime dep resolves consistently across modes.
      const install = await internal.sandbox.process.executeCommand(
        'npm install --prefer-offline --no-audit --no-fund --loglevel=error',
        SANDBOX_BUNDLE_DIR,
        undefined,
        600
      );
      if ((install.exitCode ?? 0) !== 0) {
        throw new Error(
          `sandbox(byo): npm install failed (exit ${install.exitCode}): ${install.result?.slice(0, 400) ?? ''}`
        );
      }
    },
    async exec(handle, command, options) {
      const internal = handle as ByoHandleInternal;
      const result = await internal.sandbox.process.executeCommand(
        command,
        options?.cwd,
        options?.env,
        options?.timeoutSeconds
      );
      return {
        exitCode: result.exitCode ?? 0,
        output: result.result ?? ''
      };
    },
    async destroy(handle) {
      const internal = handle as ByoHandleInternal;
      await internal.sandbox.delete();
    }
  };
}

// ─── Proxy: workforce cloud sandboxes endpoint ──────────────────────────

export interface ProxySandboxClientOptions {
  cloudUrl: string;
  workspaceId: string;
  workspaceToken: string;
  personaId: string;
  /** Defaults to global fetch; tests pass a stub. */
  fetchImpl?: typeof fetch;
}

interface ProxyHandleInternal extends SandboxHandle {
  mode: 'proxy';
  execUrl: string;
  filesUrl: string;
}

export function createProxySandboxClient(opts: ProxySandboxClientOptions): SandboxClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = `${opts.cloudUrl.replace(/\/$/, '')}/api/v1/workspaces/${encodeURIComponent(
    opts.workspaceId
  )}`;

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${opts.workspaceToken}`,
      'user-agent': 'workforce-deploy',
      ...extra
    };
  }

  return {
    async mint(args) {
      const response = await fetchImpl(`${base}/sandboxes`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          purpose: 'workforce-deploy',
          personaId: opts.personaId,
          label: args.label,
          env: args.env,
          ...(hasIntegrations(args.integrations) ? { integrations: args.integrations } : {}),
          // `timeoutSeconds` on the mint contract caps the *create call*,
          // not the sandbox lifetime. Default to 120s which matches the
          // cloud-side MAX_CREATE_TIMEOUT_SECONDS clamp.
          timeoutSeconds: args.createTimeoutSeconds ?? 120
        })
      });
      if (!response.ok) {
        throw await toError(response, 'sandbox(proxy).mint');
      }
      const body = (await response.json()) as {
        sandboxId: string;
        authMode: 'proxy';
        execUrl: string;
        filesUrl: string;
      };
      if (!body?.sandboxId || !body.execUrl || !body.filesUrl) {
        throw new Error(
          `sandbox(proxy).mint: cloud response missing sandboxId/execUrl/filesUrl: ${JSON.stringify(body)}`
        );
      }
      const handle: ProxyHandleInternal = {
        id: `proxy:${body.sandboxId}`,
        sandboxId: body.sandboxId,
        mode: 'proxy',
        execUrl: absoluteUrl(opts.cloudUrl, body.execUrl),
        filesUrl: absoluteUrl(opts.cloudUrl, body.filesUrl)
      };
      return handle;
    },
    async uploadBundle(handle, bundle) {
      const internal = handle as ProxyHandleInternal;
      const files = await readBundleFiles(bundle);
      const response = await fetchImpl(internal.filesUrl, {
        method: 'PUT',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          entries: files.map((file) => ({
            source: file.source.toString('base64'),
            destination: file.destination
          }))
        })
      });
      if (!response.ok) {
        throw await toError(response, 'sandbox(proxy).uploadBundle');
      }
      // Cloud's `files` endpoint only uploads — the install step still
      // has to go through `exec` after the files land.
      const install = await this.exec(handle, 'npm install --prefer-offline --no-audit --no-fund --loglevel=error', {
        cwd: SANDBOX_BUNDLE_DIR,
        timeoutSeconds: 600
      });
      if (install.exitCode !== 0) {
        throw new Error(
          `sandbox(proxy): npm install failed (exit ${install.exitCode}): ${install.output.slice(0, 400)}`
        );
      }
    },
    async exec(handle, command, options) {
      const internal = handle as ProxyHandleInternal;
      const response = await fetchImpl(internal.execUrl, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          command,
          ...(options?.cwd ? { cwd: options.cwd } : {}),
          ...(options?.env ? { env: options.env } : {}),
          timeoutSeconds: options?.timeoutSeconds ?? 600
        })
      });
      if (!response.ok) {
        throw await toError(response, 'sandbox(proxy).exec');
      }
      const body = (await response.json()) as { exitCode: number; output: string };
      return { exitCode: body.exitCode ?? 0, output: body.output ?? '' };
    },
    async destroy(handle) {
      const response = await fetchImpl(
        `${base}/sandboxes/${encodeURIComponent(handle.sandboxId)}`,
        {
          method: 'DELETE',
          headers: headers()
        }
      );
      if (!response.ok && response.status !== 404) {
        throw await toError(response, 'sandbox(proxy).destroy');
      }
    }
  };
}

// ─── Shared helpers ─────────────────────────────────────────────────────

async function readBundleFiles(bundle: BundleResult): Promise<
  Array<{ source: Buffer; destination: string }>
> {
  return Promise.all([
    fileUpload(bundle.runnerPath, `${SANDBOX_BUNDLE_DIR}/runner.mjs`),
    fileUpload(bundle.bundlePath, `${SANDBOX_BUNDLE_DIR}/agent.bundle.mjs`),
    fileUpload(bundle.personaCopyPath, `${SANDBOX_BUNDLE_DIR}/persona.json`),
    fileUpload(bundle.packageJsonPath, `${SANDBOX_BUNDLE_DIR}/package.json`)
  ]);
}

async function fileUpload(localPath: string, remotePath: string): Promise<{ source: Buffer; destination: string }> {
  const source = await readFile(localPath);
  return { source, destination: remotePath };
}

function hasIntegrations(integrations: PersonaIntegrations | undefined): integrations is PersonaIntegrations {
  return integrations !== undefined && Object.keys(integrations).length > 0;
}

function absoluteUrl(cloudBase: string, maybeRelative: string): string {
  if (/^https?:\/\//.test(maybeRelative)) return maybeRelative;
  // Cloud sometimes returns relative paths (`/api/v1/...`); attach the
  // configured base so the workforce CLI can call them outside the
  // cloud's own hostname.
  return `${cloudBase.replace(/\/$/, '')}${maybeRelative.startsWith('/') ? '' : '/'}${maybeRelative}`;
}

async function toError(response: Response, label: string): Promise<Error> {
  const body = await response.text().catch(() => '');
  const excerpt = body.length > 400 ? `${body.slice(0, 400)}…` : body;
  return new Error(
    `${label}: ${response.status} ${response.statusText}${excerpt ? ` — ${excerpt}` : ''}`
  );
}
