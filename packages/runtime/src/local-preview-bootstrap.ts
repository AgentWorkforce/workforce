import { readFileSync } from 'node:fs';
import type { LocalPreviewGuardConfig } from './local-preview-contract.js';
import { installPreviewProcessGuards } from './local-preview-hooks.js';

const controlPath = process.env.WORKFORCE_LOCAL_PREVIEW_CONTROL_PATH;
if (!controlPath) {
  throw new Error('invoke: preview worker missing WORKFORCE_LOCAL_PREVIEW_CONTROL_PATH');
}

const config = JSON.parse(readFileSync(controlPath, 'utf8')) as LocalPreviewGuardConfig;
installPreviewProcessGuards(config);
