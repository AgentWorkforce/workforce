import { createInterface } from 'node:readline/promises';
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import type { DeployMode } from '@agentworkforce/deploy';

export const BUILD_YOUR_OWN_RUNTIME_DOCS_URL = 'https://agentrelay.com/docs/runtimes';

export type RuntimePickerResult = DeployMode | 'docs';

export async function pickRuntime(opts: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
} = {}): Promise<RuntimePickerResult> {
  const input = opts.input ?? defaultStdin;
  const output = opts.output ?? defaultStdout;
  output.write(
    [
      'Which runtime should this persona run on?',
      '  [1] AgentRelay (recommended) - managed cloud, schedules + integrations + memory wired',
      '  [2] Local sandbox            - runs in a local Daytona container',
      '  [3] Local dev                - runs directly on your machine',
      '  [4] Build your own           - docs at https://agentrelay.com/docs/runtimes',
      ''
    ].join('\n')
  );

  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question('> ')).trim() || '1';
    switch (answer) {
      case '1':
        return 'cloud';
      case '2':
        return 'sandbox';
      case '3':
        return 'dev';
      case '4':
        return 'docs';
      default:
        throw new Error(`runtime picker: expected 1, 2, 3, or 4; got "${answer}"`);
    }
  } finally {
    rl.close();
  }
}
