import type { WorkforceHandler } from './index.js';

export interface StartRunnerInput {
  persona: unknown;
  handler: WorkforceHandler;
}

export function startRunner(_input: StartRunnerInput): void {
  // TODO(human): wire this to @agent-relay/agent once the runtime core lands.
  console.log('[runtime] runner shim loaded; runtime core is not wired yet');
}
