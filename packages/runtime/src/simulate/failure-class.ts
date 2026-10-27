/**
 * Failure classification for simulated runs.
 *
 * The union MIRRORS Cloud's hosted run model verbatim
 * (cloud: `packages/web/lib/proactive-runtime/deployment-run-failure-class.ts`,
 * shipped in AgentWorkforce/cloud#1788) so a simulated run record is
 * type-compatible with hosted run records and Cloud can ingest/display
 * `origin: "local_dry_run"` runs without redesign.
 *
 * A local simulation never provisions a sandbox, installs deps, mounts a
 * Relayfile, or stages a bundle, so in practice it only produces `success`
 * or `runner_error` — but the full union is kept so the contract stays
 * identical across origins.
 */
export type SimulatedRunFailureClass =
  | 'success'
  | 'bootstrap_failed'
  | 'bundle_unavailable'
  | 'dep_install_failed'
  | 'runner_error'
  | 'mount_failure'
  | 'cleanup_warning';

export interface SimulatedRunFailureInput {
  /** Run status using Cloud's vocabulary: `succeeded` | `failed`. */
  status: string;
  /** Error message captured from the handler, if it threw. */
  error: string | null;
}

/**
 * Derive the failure class for a simulated run. Mirrors the invariant Cloud
 * enforces for hosted runs: a failure-ish status or a present error message
 * can never classify as `success`.
 */
export function deriveSimulatedRunFailureClass(
  input: SimulatedRunFailureInput
): SimulatedRunFailureClass {
  const status = input.status.toLowerCase();
  const hasError = typeof input.error === 'string' && input.error.trim().length > 0;
  if ((status === 'succeeded' || status === 'success') && !hasError) {
    return 'success';
  }
  return 'runner_error';
}
