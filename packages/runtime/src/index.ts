export { WorkforceIntegrationError } from './errors.js';
export type { WorkforceIntegrationErrorOptions } from './errors.js';
import type {
  GithubClient,
  JiraClient,
  LinearClient,
  NotionClient,
  SlackClient
} from './clients/index.js';

export {
  createGithubClient,
  createJiraClient,
  createLinearClient,
  createNotionClient,
  createSlackClient
} from './clients/index.js';

export type {
  GithubClient,
  JiraClient,
  LinearClient,
  NotionClient,
  SlackClient
} from './clients/index.js';

export interface WorkforceEvent {
  source: 'cron' | 'github' | 'linear' | 'slack' | 'notion' | 'jira' | string;
  type?: string;
  name?: string;
  firedAt?: string;
  [key: string]: unknown;
}

export interface WorkforceCtx {
  github?: GithubClient;
  linear?: LinearClient;
  slack?: SlackClient;
  notion?: NotionClient;
  jira?: JiraClient;
  harness: {
    run(args: {
      prompt: string;
      cwd?: string;
      tier?: 'best' | 'best-value' | 'minimum';
    }): Promise<{ output: string; [key: string]: unknown }>;
  };
  sandbox: {
    cwd: string;
    exec(cmd: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<unknown>;
    readFile(path: string): Promise<string>;
    writeFile(path: string, contents: string): Promise<void>;
  };
  memory: {
    save(content: string, opts?: { tags?: string[]; scope?: 'session' | 'user' | 'workspace' }): Promise<void>;
    recall(query: string, opts?: { limit?: number }): Promise<unknown[]>;
  };
  workflow: {
    run(name: string, args: Record<string, unknown>): Promise<unknown>;
  };
  schedule: {
    at(when: Date, payload: unknown): Promise<void>;
    cancel(name: string): Promise<void>;
  };
  persona: {
    inputs?: Record<string, { default?: string }>;
    [key: string]: unknown;
  };
}

export type WorkforceHandler = (ctx: WorkforceCtx, event: WorkforceEvent) => Promise<void>;

export function handler(fn: WorkforceHandler): WorkforceHandler {
  // TODO(human): replace this thin identity wrapper with the Agent Relay runtime shim.
  return fn;
}
