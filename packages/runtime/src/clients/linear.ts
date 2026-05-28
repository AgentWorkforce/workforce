import {
  draftFile,
  encodeSegment,
  type IntegrationClientOptions,
  listJsonFiles,
  readJsonFile,
  writeJsonFile
} from './request.js';

/**
 * A Linear project as stored in the Relayfile VFS.
 * Shape matches the Linear adapter's `/linear/projects/<id>.json` output.
 */
export interface LinearProject {
  id: string;
  name: string;
  slug?: string;
  state?: string;
  teamIds?: string[];
  [key: string]: unknown;
}

/**
 * A Linear issue as stored in the Relayfile VFS.
 * Shape matches the Linear adapter's `/linear/issues/<id>.json` output.
 */
export interface LinearIssue {
  id: string;
  identifier?: string;
  title: string;
  description?: string | null;
  state?: { name: string } | string;
  project?: LinearProject | null;
  projectId?: string;
  assignee?: { id: string; name: string; displayName?: string } | null;
  dueDate?: string | null;
  url?: string;
  [key: string]: unknown;
}

/**
 * A Linear team as stored in the Relayfile VFS.
 * Shape matches the Linear adapter's `/linear/teams/<id>.json` output.
 */
export interface LinearTeam {
  id: string;
  name: string;
  key?: string;
  [key: string]: unknown;
}

/**
 * A Linear workflow state as stored in the Relayfile VFS.
 * Shape matches the Linear adapter's `/linear/workflow-states/<id>.json` output.
 */
export interface LinearWorkflowState {
  id: string;
  name: string;
  type?: string;
  teamId?: string;
  [key: string]: unknown;
}

export interface LinearClient {
  /** Write a new Linear issue via the writeback worker. */
  createIssue(args: {
    teamId: string;
    title: string;
    description?: string;
    assigneeId?: string;
    labelIds?: string[];
    projectId?: string;
    stateId?: string;
  }): Promise<{ id: string; identifier: string; url: string }>;
  /** Write field updates to an existing issue. */
  updateIssue(
    issueId: string,
    args: { title?: string; description?: string; assigneeId?: string; stateId?: string }
  ): Promise<{ id: string; identifier: string; url: string }>;
  /** Write a comment on an issue. */
  comment(issueId: string, body: string): Promise<{ id: string; url: string }>;
  /** Read a single issue by its id. */
  getIssue(issueId: string): Promise<LinearIssue>;
  /**
   * List all Linear projects from the VFS.
   * Reads every `linear/projects/*.json` file (excluding `_index.json`).
   */
  listProjects(): Promise<LinearProject[]>;
  /**
   * List all Linear issues from the VFS, optionally filtered.
   * Reads `linear/issues/*.json`. Filtering by `projectId` or `teamId`
   * is done client-side after reading — the VFS holds a flat list.
   */
  listIssues(opts?: { projectId?: string; teamId?: string }): Promise<LinearIssue[]>;
  /**
   * List all Linear teams from the VFS.
   * Reads `linear/teams/*.json`.
   */
  getTeams(): Promise<LinearTeam[]>;
  /**
   * List workflow states, optionally filtered by team.
   * Reads `linear/workflow-states/*.json` or `linear/states/*.json`.
   */
  getWorkflowStates(opts?: { teamId?: string }): Promise<LinearWorkflowState[]>;
}

export function createLinearClient(opts: IntegrationClientOptions): LinearClient {
  return {
    async createIssue(args) {
      const result = await writeJsonFile(
        opts,
        'linear',
        'createIssue',
        `/linear/issues/${draftFile('create issue')}`,
        args
      );
      return {
        id: result.receipt?.created ?? result.receipt?.id ?? result.path,
        identifier: typeof result.receipt?.identifier === 'string' ? result.receipt.identifier : '',
        url: result.receipt?.url ?? result.path
      };
    },

    async updateIssue(issueId, args) {
      await writeJsonFile(opts, 'linear', 'updateIssue', `/linear/issues/${encodeSegment(issueId)}.json`, args);
      const issue = await this.getIssue(issueId).catch(() => undefined);
      return {
        id: issue?.id ?? issueId,
        identifier: issue?.identifier ?? '',
        url: issue?.url ?? ''
      };
    },

    async comment(issueId, body) {
      const result = await writeJsonFile(
        opts,
        'linear',
        'comment',
        `/linear/issues/${encodeSegment(issueId)}/comments/${draftFile('create comment')}`,
        { body }
      );
      return {
        id: result.receipt?.created ?? result.receipt?.id ?? result.path,
        url: result.receipt?.url ?? result.path
      };
    },

    getIssue(issueId) {
      return readJsonFile<LinearIssue>(opts, 'linear', 'getIssue', `/linear/issues/${encodeSegment(issueId)}.json`);
    },

    async listProjects() {
      const files = await listJsonFiles<LinearProject>(opts, 'linear', 'listProjects', '/linear/projects');
      return files.map((f) => f.value);
    },

    async listIssues(filters) {
      const files = await listJsonFiles<LinearIssue>(opts, 'linear', 'listIssues', '/linear/issues');
      let issues = files.map((f) => f.value);
      if (filters?.projectId) {
        issues = issues.filter(
          (i) =>
            i.projectId === filters.projectId ||
            (i.project as Record<string, unknown>)?.id === filters.projectId
        );
      }
      if (filters?.teamId) {
        issues = issues.filter(
          (i) =>
            (i.project as Record<string, unknown>)?.teamId === filters.teamId ||
            (i as Record<string, unknown>)['teamId'] === filters.teamId
        );
      }
      return issues;
    },

    async getTeams() {
      const files = await listJsonFiles<LinearTeam>(opts, 'linear', 'getTeams', '/linear/teams');
      return files.map((f) => f.value);
    },

    async getWorkflowStates(filters) {
      // Linear adapter may write states under either path — try both.
      let files = await listJsonFiles<LinearWorkflowState>(opts, 'linear', 'getWorkflowStates', '/linear/workflow-states');
      if (files.length === 0) {
        files = await listJsonFiles<LinearWorkflowState>(opts, 'linear', 'getWorkflowStates', '/linear/states');
      }
      let states = files.map((f) => f.value);
      if (filters?.teamId) {
        states = states.filter((s) => s.teamId === filters.teamId);
      }
      return states;
    }
  };
}
