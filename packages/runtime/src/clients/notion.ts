import { providerRequest, type IntegrationClientOptions } from './request.js';

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

const notionHeaders = { 'notion-version': '2022-06-28' };

export function createNotionClient(opts: IntegrationClientOptions): NotionClient {
  const request = <T>(operation: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    providerRequest<T>({
      provider: 'notion',
      operation,
      client: opts,
      endpoint: `/v1/${path}`,
      headers: notionHeaders,
      ...init
    });

  return {
    createPage(parent, properties, content) {
      return request<NotionPage>('createPage', 'pages', {
        body: { parent, properties, children: content }
      });
    },

    updatePage(pageId, args) {
      return request<NotionPage>('updatePage', `pages/${encodeURIComponent(pageId)}`, {
        method: 'PATCH',
        body: args
      });
    },

    getPage(pageId) {
      return request<NotionPage>('getPage', `pages/${encodeURIComponent(pageId)}`);
    }
  };
}
