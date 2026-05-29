// Shared VFS-backed transport surface. All provider interactions go through
// these helpers — no per-provider client code lives in the runtime. Handlers
// and custom clients import these directly instead of recreating the
// path-validation + receipt-polling logic.
export {
  draftFile,
  encodeSegment,
  listDirectoryEntries,
  listJsonFiles,
  readJsonFile,
  readTextFile,
  resolveMountRoot,
  writeJsonFile,
  type IntegrationClientOptions,
  type WritebackReceipt,
  type WritebackResult
} from './request.js';

export { WorkforceIntegrationError, SandboxNotAvailableError } from '../errors.js';
