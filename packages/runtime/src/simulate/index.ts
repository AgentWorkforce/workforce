// Invocation dry-run / simulation surface (workforce#186).
//
// `simulateInvocation` executes a persona handler against fixture envelopes
// with every external side effect recorded-not-executed, and emits run
// records mirroring Cloud's hosted compact run shape with
// `origin: "local_dry_run"` (cloud#1783 / cloud#1788).

export { simulateInvocation } from './simulate.js';
export {
  createSimulationSubsystems,
  type SimulationSink,
  type SimulationSubsystems
} from './subsystems.js';
export {
  deriveSimulatedRunFailureClass,
  type SimulatedRunFailureClass,
  type SimulatedRunFailureInput
} from './failure-class.js';
export type {
  CapturedLogLine,
  RecordedSideEffect,
  SimulateInvocationOptions,
  SimulatedRunRecord,
  SimulationResult,
  UnsupportedEnvelope
} from './types.js';
