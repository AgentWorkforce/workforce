export {
  createGithubClient,
  type GithubClient
} from './github.js';

export { createLinearClient, type LinearClient } from './linear.js';

export { createSlackClient, type SlackClient } from './slack.js';

export { createNotionClient, type NotionClient } from './notion.js';

export { createJiraClient, type JiraClient } from './jira.js';

// Shared VFS-backed transport surface. Consumers building custom
// clients (a new provider, an in-house writeback variant) can import
// these directly instead of recreating the path-validation +
// receipt-polling logic.
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
