import type { PersonaSpec } from '@agentworkforce/persona-kit';

export type DeployMode = 'dev' | 'sandbox' | 'cloud';

export interface DeployOptions {
  /** Absolute path to the persona JSON file. Required. */
  personaPath: string;
  /** Run mode. Defaults to `sandbox` if Daytona creds resolve, else `dev`. */
  mode?: DeployMode;
  /** Workforce workspace to deploy into. Defaults to the active workspace. */
  workspace?: string;
  /** Skip the integration-connect prompts; fail if any declared integration is missing. */
  noConnect?: boolean;
  /** Force BYO Daytona even when workforce-managed sandbox issuance is available. */
  byoSandbox?: boolean;
  /** Background the runner instead of streaming logs in the foreground. */
  detach?: boolean;
  /** Emit the bundle to this directory and exit (no launch). */
  bundleOut?: string;
  /** Validate-only: parse + lint + check connection status, no side effects. */
  dryRun?: boolean;
  /** Override the WORKFORCE_CLOUD_URL; defaults to env or production. */
  cloudUrl?: string;
  /** Localhost-only bearer token for cloud dev auth bypass. */
  devToken?: string;
  /** Fail instead of prompting for cloud auth/integration setup. */
  noPrompt?: boolean;
  /** Cloud harness credential source. */
  harnessSource?: 'plan' | 'byok' | 'oauth';
  /** BYOK API key used when `harnessSource` is `byok`. */
  byokKey?: string;
  /** Existing cloud persona behavior. Defaults to `cancel`. */
  onExists?: 'update' | 'destroy' | 'cancel';
  /** Deploy-time persona input overrides, supplied as `--input KEY=value`. Forwarded to hosted cloud deployments. */
  inputs?: Record<string, string>;
  /** Runtime log streaming hook. */
  onLog?: (line: string) => void;
  /** Override stdout writer for tests + structured outputs. */
  io?: DeployIO;
}

export interface DeployIO {
  /** User-facing progress line (clean prose, suitable for terminals). */
  info(message: string): void;
  /** Warning line; rendered with a marker the user reads. */
  warn(message: string): void;
  /** Error line; non-fatal context. */
  error(message: string): void;
  /** Interactive prompt; resolves to user's answer. */
  prompt(question: string, opts?: { defaultValue?: string }): Promise<string>;
  /** Confirmation prompt; resolves to true/false. */
  confirm(question: string, opts?: { defaultValue?: boolean }): Promise<boolean>;
}

/** The result returned by a successful `deploy(...)` call. */
export interface DeployResult {
  /** Resolved deployment identifier (stable across restarts of the same persona). */
  deploymentId: string;
  /** Which run mode the orchestrator picked. */
  mode: DeployMode;
  /** Workspace the deployment is scoped to. */
  workspace: string;
  /** Path to the staged bundle on disk. */
  bundleDir: string;
  /** Integrations that were connected (or already-connected) as part of this deploy. */
  connectedIntegrations: string[];
  /** Schedules registered with the runtime. */
  schedules: string[];
  /** Run-mode-specific handle. `dev` returns a child process handle; `sandbox` a Daytona sandbox id; `cloud` a server-side deployment id. */
  runHandle?: unknown;
  /** Non-fatal warnings collected during deploy. */
  warnings: string[];
}

/**
 * Contract the deploy orchestrator expects from the bundle stager. The
 * default implementation lives in `bundle.ts` (esbuild-driven); callers
 * pass an alternative via `DeployResolvers.bundle` to swap bundlers or
 * inject test fakes.
 */
export interface BundleStager {
  stage(input: BundleStageInput): Promise<BundleResult>;
}

export interface BundleStageInput {
  personaPath: string;
  persona: PersonaSpec;
  outDir: string;
  bundlerOptions?: { minify?: boolean };
}

export interface BundleResult {
  personaCopyPath: string;
  runnerPath: string;
  bundlePath: string;
  packageJsonPath: string;
  sizeBytes: number;
}

/**
 * Contract each run-mode launcher implements. The defaults live next
 * to this file: `modes/dev.ts` (local child_process), `modes/sandbox.ts`
 * (Daytona), and `modes/cloud.ts` (workforce-cloud hosted, opt-in once
 * the cloud deployments endpoint ships). Callers swap individual modes
 * via `DeployResolvers.modes` — useful for tests and custom runtimes.
 */
export interface ModeLauncher {
  launch(input: ModeLaunchInput): Promise<ModeLaunchHandle>;
}

export interface ModeLaunchInput {
  persona: PersonaSpec;
  bundle: BundleResult;
  workspace: string;
  env?: Record<string, string>;
  io: DeployIO;
  detach?: boolean;
  /**
   * Force BYO Daytona auth even when the user is logged in to workforce
   * cloud. Mode-specific (sandbox launcher only); other modes ignore.
   */
  byoSandbox?: boolean;
  /** Workspace-scoped auth token resolved by the deploy orchestrator. */
  workspaceToken?: string;
  /** Cloud base URL override. */
  cloudUrl?: string;
  /** Localhost-only bearer token for cloud dev auth bypass. */
  devToken?: string;
  /** Fail instead of prompting for cloud setup. */
  noPrompt?: boolean;
  /** Cloud harness credential source. */
  harnessSource?: 'plan' | 'byok' | 'oauth';
  /** BYOK API key used when `harnessSource` is `byok`. */
  byokKey?: string;
  /** Existing cloud persona behavior. Defaults to `cancel`. */
  onExists?: 'update' | 'destroy' | 'cancel';
  /** Runtime inputs forwarded to launchers that support them. */
  inputs?: Record<string, string>;
  /** Runtime log streaming hook. */
  onLog?: (line: string) => void;
}

export interface ModeLaunchHandle {
  /** Mode-specific identifier (pid for dev, sandboxId for sandbox, deploymentId for cloud). */
  id: string;
  /** Stop the runner cleanly. */
  stop(): Promise<void>;
  /**
   * Resolves when the runner exits. For long-lived modes (sandbox), this
   * resolves only when the user invokes `stop()`.
   */
  done: Promise<{ code: number }>;
}

export interface IntegrationConnectOutcome {
  provider: string;
  status: 'already-connected' | 'connected-now' | 'skipped' | 'failed';
  message?: string;
}

/** Surface a parsed persona only after we know it passed the deploy preflight. */
export interface DeployPreflight {
  persona: PersonaSpec;
  /** Persona JSON path resolved to absolute. */
  personaPath: string;
  /** Absolute path to the directory containing the persona JSON. */
  personaDir: string;
  /** Absolute path to the resolved `onEvent` file. */
  onEventPath: string;
  /** Schedules and integrations summarized. */
  schedules: string[];
  integrations: string[];
  /** Non-fatal warnings (unknown triggers, etc). */
  warnings: string[];
}
