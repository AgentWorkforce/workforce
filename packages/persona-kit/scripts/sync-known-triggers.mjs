import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADAPTERS_WITHOUT_KNOWN_TRIGGERS,
  KNOWN_TRIGGER_CATALOG
} from '@relayfile/adapter-core';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(packageRoot, 'src/known-triggers.generated.ts');
const check = process.argv.includes('--check');

const contents = `/**
 * Vendored from @relayfile/adapter-core's generated trigger catalog.
 * Regenerate with \`pnpm --filter @agentworkforce/persona-kit sync:known-triggers\`.
 *
 * Event names are emitted verbatim from adapter supportedEvents() methods or
 * mapping.yaml webhooks keys. Do not normalize names across providers: the
 * cloud runtime matches persona triggers against each adapter's real event.type.
 */

export const KNOWN_TRIGGER_CATALOG = ${JSON.stringify(KNOWN_TRIGGER_CATALOG, null, 2)} as const satisfies Record<
  string,
  readonly string[]
>;

export const ADAPTERS_WITHOUT_KNOWN_TRIGGERS = ${JSON.stringify(ADAPTERS_WITHOUT_KNOWN_TRIGGERS, null, 2)} as const;

export type KnownProviderName = keyof typeof KNOWN_TRIGGER_CATALOG;
export type KnownTriggerName<P extends KnownProviderName> =
  (typeof KNOWN_TRIGGER_CATALOG)[P][number];
`;

if (check) {
  const current = await readFile(outputPath, 'utf8');
  if (current !== contents) {
    throw new Error(
      'known trigger catalog is out of sync; run `pnpm --filter @agentworkforce/persona-kit sync:known-triggers`'
    );
  }
} else {
  await writeFile(outputPath, contents);
}
