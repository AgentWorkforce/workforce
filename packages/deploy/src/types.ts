import type { AgentSpec, PersonaSpec } from '@agentworkforce/persona-kit';

export type DeployMode = 'dev' | 'sandbox' | 'cloud';

export interface DeployOptions {
  /** Path to the persona JSON file or authored persona source module. Required. */
  personaPath: string;
  /** Run mode. Defaults to `sandbox` if Daytona creds resolve, else `dev`. */
  mode?: DeployMode;
  /** Workforce workspace to deploy into. Defaults to the active workspace. */
  workspace?: string;
  /** Skip the integration-connect prompts; fail if any declared integration is missing. */
  noConnect?: boolean;
  /** Force a fresh OAuth/connect flow for specific providers, even if status is ready. */
  reconnectProviders?: string[];
  /** Force BYO Daytona even when workforce-managed sandbox issuance is available. */
  byoSandbox?: boolean;
  /** Background the runner instead of streaming logs in the foreground. */
  detach?: boolean;
  /**
   * The caller drives the runner's envelope stdin itself via the returned
   * `ModeLaunchHandle.write()`, instead of the runner's stdin passing
   * through this process's own stdin (`dev` mode only; ignored otherwise).
   * Set this when calling `deploy()` from a long-lived host process (e.g. a
   * fleet-node bridge) whose own stdin lifecycle must not end the runner's.
   */
  bridged?: boolean;
  /** Emit the bundle to this directory and exit (no launch). */
  bundleOut?: string;
  /** Validate-only: parse + lint + check connection status, no side effects. */
  dryRun?: boolean;
  /** Override the WORKFORCE_CLOUD_URL; defaults to env or production. */
  cloudUrl?: string;
  /** Fail instead of prompting for cloud auth/integration setup. */
  noPrompt?: boolean;
  /** Cloud harness credential source. */
  harnessSource?: 'managed' | 'plan' | 'byok' | 'oauth';
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
  /**
   * Single-choice picker; resolves to the chosen option's `value`. Optional:
   * the onboarding picker falls back to a numbered `prompt` when an IO does
   * not implement it, so existing IOs keep working unchanged.
   */
  select?(
    question: string,
    options: Array<{ value: string; label: string; hint?: string }>
  ): Promise<string>;
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
 * (Daytona), and `modes/cloud/index.ts` (workforce-cloud hosted, opt-in once
 * the cloud deployments endpoint ships). Callers swap individual modes
 * via `DeployResolvers.modes` — useful for tests and custom runtimes.
 */
export interface ModeLauncher {
  launch(input: ModeLaunchInput): Promise<ModeLaunchHandle>;
}

export interface ModeLaunchInput {
  persona: PersonaSpec;
  /**
   * Agent listener spec (triggers/schedules/watch) extracted from the
   * `defineAgent(...)` default export. Cloud mode sends this as the top-level
   * `agent` block in the deploy request so the cloud sets up subscriptions.
   */
  agent: AgentSpec;
  bundle: BundleResult;
  workspace: string;
  env?: Record<string, string>;
  io: DeployIO;
  detach?: boolean;
  /**
   * The caller drives the runner's envelope stdin itself via the returned
   * `ModeLaunchHandle.write()`. `dev` mode only — see `DeployOptions.bridged`;
   * other modes ignore.
   */
  bridged?: boolean;
  /**
   * Force BYO Daytona auth even when the user is logged in to workforce
   * cloud. Mode-specific (sandbox launcher only); other modes ignore.
   */
  byoSandbox?: boolean;
  /** Workspace-scoped auth token resolved by the deploy orchestrator. */
  workspaceToken?: string;
  /** Cloud base URL override. */
  cloudUrl?: string;
  /** Fail instead of prompting for cloud setup. */
  noPrompt?: boolean;
  /** Cloud harness credential source. */
  harnessSource?: 'managed' | 'plan' | 'byok' | 'oauth';
  /** BYOK API key used when `harnessSource` is `byok`. */
  byokKey?: string;
  /**
   * Force a fresh OAuth connect flow for specific providers even when cloud
   * already reports one connected. Covers the harness LLM credential (matched
   * by model provider or harness name), so a revoked harness token can be
   * refreshed without first disconnecting it in the dashboard.
   */
  reconnectProviders?: string[];
  /** Existing cloud persona behavior. Defaults to `cancel`. */
  onExists?: 'update' | 'destroy' | 'cancel';
  /** Runtime inputs forwarded to launchers that support them. */
  inputs?: Record<string, string>;
  /** Provider credential selections resolved before launch. Cloud mode includes these in the deploy request. */
  credentialSelections?: Record<string, string>;
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
  /**
   * Write a raw line directly to the runner's envelope stdin, bypassing the
   * `process.stdin` passthrough. Only `dev` mode implements this today — it
   * lets a long-lived host process (e.g. a fleet-node bridge) that owns the
   * `deploy()` call feed one `RawGatewayEnvelope` per message without a real
   * piped parent stdin. Absent when the mode has no addressable stdin.
   */
  write?(line: string): void;
}

export interface IntegrationConnectOutcome {
  provider: string;
  status: 'already-connected' | 'connected-now' | 'skipped' | 'failed';
  message?: string;
}

/** Surface a parsed persona only after we know it passed the deploy preflight. */
export interface DeployPreflight {
  persona: PersonaSpec;
  /**
   * Listener spec (triggers/schedules/watch) extracted from the agent's
   * `defineAgent(...)` default export. Travels to the cloud as the deploy
   * `agent` block.
   */
  agent: AgentSpec;
  /** Persona path resolved to absolute. */
  personaPath: string;
  /** Absolute path to the directory containing the persona file. */
  personaDir: string;
  /** Absolute path to the resolved `onEvent` file. */
  onEventPath: string;
  /** Schedules and integrations summarized. */
  schedules: string[];
  integrations: string[];
  /** Non-fatal warnings (unknown triggers, etc). */
  warnings: string[];
}
