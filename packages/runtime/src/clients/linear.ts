import {
  draftFile,
  encodeSegment,
  type IntegrationClientOptions,
  listJsonFiles,
  readJsonFile,
  writeJsonFile
} from './request.js';

import type {
  LinearIssue,
  LinearProject,
  LinearTeam,
  LinearState,
} from '@relayfile/adapter-linear/types';

// Re-export adapter types for consumer convenience
export type { LinearIssue, LinearProject, LinearTeam };
/** LinearState from the adapter represents a workflow state. */
export type LinearWorkflowState = LinearState;

export interface LinearClient {
  createIssue(args: {
    teamId: string;
    title: string;
    description?: string;
    assigneeId?: string;
    labelIds?: string[];
    projectId?: string;
    stateId?: string;
  }): Promise<{ id: string; identifier: string; url: string }>;
  updateIssue(
    issueId: string,
    args: { title?: string; description?: string; assigneeId?: string; stateId?: string }
  ): Promise<{ id: string; identifier: string; url: string }>;
  comment(issueId: string, body: string): Promise<{ id: string; url: string }>;
  getIssue(issueId: string): Promise<LinearIssue>;
  listProjects(): Promise<LinearProject[]>;
  listIssues(filters?: { projectId?: string; teamId?: string }): Promise<LinearIssue[]>;
  getTeams(): Promise<LinearTeam[]>;
  getWorkflowStates(): Promise<LinearWorkflowState[]>;
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
        issues = issues.filter((i) => i.project?.id === filters.projectId);
      }
      if (filters?.teamId) {
        issues = issues.filter(
          (i) => i.team?.id === filters.teamId || i.project?.id === filters.projectId
        );
      }
      return issues;
    },

    async getTeams() {
      const files = await listJsonFiles<LinearTeam>(opts, 'linear', 'getTeams', '/linear/teams');
      return files.map((f) => f.value);
    },

    async getWorkflowStates() {
      // Linear adapter may write states under either path — try both.
      const files = await listJsonFiles<LinearWorkflowState>(opts, 'linear', 'getWorkflowStates', '/linear/workflow-states');
      if (files.length === 0) {
        return listJsonFiles<LinearWorkflowState>(opts, 'linear', 'getWorkflowStates', '/linear/states').then((f) =>
          f.map((f) => f.value)
        );
      }
      return files.map((f) => f.value);
    }
  };
}
