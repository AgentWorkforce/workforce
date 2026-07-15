import { readFile, writeFile } from 'node:fs/promises';
import type {
  LocalPreviewWorkerPayload,
  LocalPreviewWorkerResult
} from './local-preview-contract.js';
import { executeLocalRunInWorkerProcess } from './local-preview-executor.js';
import { getPreviewProcessState } from './local-preview-hooks.js';

const payloadPath = process.env.WORKFORCE_LOCAL_PREVIEW_PAYLOAD_PATH;
const resultPath = process.env.WORKFORCE_LOCAL_PREVIEW_RESULT_PATH;

if (!payloadPath || !resultPath) {
  throw new Error('invoke: preview worker missing payload/result path env');
}

try {
  const payload = JSON.parse(await readFile(payloadPath, 'utf8')) as LocalPreviewWorkerPayload;
  const result = await executeLocalRunInWorkerProcess(payload);
  const output: LocalPreviewWorkerResult = {
    ok: true,
    ...result
  };
  await writeFile(resultPath, JSON.stringify(output), 'utf8');
} catch (error) {
  const failure: LocalPreviewWorkerResult = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {})
  };
  await writeFile(resultPath, JSON.stringify(failure), 'utf8');
  process.exitCode = 1;
} finally {
  getPreviewProcessState()?.cleanup();
}
