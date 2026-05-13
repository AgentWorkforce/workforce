import { WorkforceIntegrationError } from '../errors.js';
import {
  draftFile,
  encodeSegment,
  type IntegrationClientOptions,
  readJsonFile,
  writeJsonFile
} from './request.js';

export interface NotionPage {
  id: string;
  url?: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NotionClient {
  createPage(
    parent: Record<string, unknown>,
    properties: Record<string, unknown>,
    content: Array<Record<string, unknown>>
  ): Promise<NotionPage>;
  updatePage(
    pageId: string,
    args: { properties?: Record<string, unknown>; archived?: boolean; inTrash?: boolean }
  ): Promise<NotionPage>;
  getPage(pageId: string): Promise<NotionPage>;
}

function readDatabaseId(parent: Record<string, unknown>): string {
  const databaseId = parent.database_id ?? parent.databaseId;
  if (typeof databaseId !== 'string' || databaseId.trim().length === 0) {
    throw new WorkforceIntegrationError({
      provider: 'notion',
      operation: 'createPage',
      cause: new Error('Notion createPage requires parent.database_id'),
      retryable: false
    });
  }
  return databaseId.trim();
}

export function createNotionClient(opts: IntegrationClientOptions): NotionClient {
  return {
    async createPage(parent, properties, content) {
      const databaseId = readDatabaseId(parent);
      const result = await writeJsonFile(
        opts,
        'notion',
        'createPage',
        `/notion/databases/${encodeSegment(databaseId)}/pages/${draftFile('create page')}`,
        { properties, children: content }
      );
      return {
        id: result.receipt?.created ?? result.receipt?.id ?? '',
        url: result.receipt?.url,
        properties
      };
    },

    async updatePage(pageId, args) {
      await writeJsonFile(opts, 'notion', 'updatePage', `/notion/pages/${encodeSegment(pageId)}.json`, args);
      return this.getPage(pageId).catch(() => ({ id: pageId, ...args }));
    },

    getPage(pageId) {
      return readJsonFile<NotionPage>(opts, 'notion', 'getPage', `/notion/pages/${encodeSegment(pageId)}.json`);
    }
  };
}
