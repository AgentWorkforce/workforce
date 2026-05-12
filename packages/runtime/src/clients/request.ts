import { WorkforceIntegrationError } from '../errors.js';

export interface IntegrationClientOptions {
  connectionId?: string;
  relayfileBaseUrl: string;
  relayfileApiToken?: string;
  cloudApiToken?: string;
  workspaceId?: string;
  slackTeamId?: string;
}

export interface ProviderRequestOptions<TBody = unknown> {
  provider: string;
  operation: string;
  client: IntegrationClientOptions;
  endpoint: string;
  method?: string;
  body?: TBody;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  parseAs?: 'json' | 'text' | 'void';
}

interface HttpFailure {
  status: number;
  statusText: string;
  body: string;
  code?: string;
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function retryableFailure(cause: unknown): boolean {
  if (isRecord(cause) && 'status' in cause) {
    return retryableStatus(Number(cause.status));
  }
  return false;
}

function proxyPath(provider: string): string {
  return `/api/v1/proxy/${encodeURIComponent(provider)}`;
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function buildProxyBody<TBody>(options: ProviderRequestOptions<TBody>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    endpoint: normalizeEndpoint(options.endpoint),
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST')
  };

  const workspaceId = readString(options.client.workspaceId);
  const slackTeamId = readString(options.client.slackTeamId);
  const connectionId = readString(options.client.connectionId);

  if (workspaceId) {
    body.workspaceId = workspaceId;
  }
  if (slackTeamId) {
    body.slackTeamId = slackTeamId;
  }
  if (options.provider !== 'slack' && connectionId) {
    body.connectionId = connectionId;
  }
  if (options.body !== undefined) {
    body.data = options.body;
  }
  if (options.params !== undefined) {
    body.params = options.params;
  }
  if (options.provider !== 'slack' && options.headers !== undefined) {
    body.headers = options.headers;
  }

  return body;
}

function unwrapProxyPayload<TResult>(payload: unknown): TResult {
  if (!isRecord(payload) || typeof payload.ok !== 'boolean') {
    return payload as TResult;
  }

  if (!payload.ok) {
    const code = readString(payload.code);
    throw {
      status: code === 'rate_limited' ? 429 : code === 'upstream_error' ? 502 : 400,
      statusText: 'Proxy Error',
      body: readString(payload.error) ?? 'Provider proxy request failed',
      code
    } satisfies HttpFailure;
  }

  return ('data' in payload ? payload.data : undefined) as TResult;
}

export async function providerRequest<TResult = unknown, TBody = unknown>(
  options: ProviderRequestOptions<TBody>
): Promise<TResult> {
  const baseUrl = options.client.relayfileBaseUrl.replace(/\/+$/, '');
  const proxyUrl = `${baseUrl}${proxyPath(options.provider)}`;
  const apiToken = options.client.cloudApiToken ?? options.client.relayfileApiToken;

  try {
    const response = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {})
      },
      body: JSON.stringify(buildProxyBody(options))
    });

    if (!response.ok) {
      const body = await response.text();
      throw {
        status: response.status,
        statusText: response.statusText,
        body
      } satisfies HttpFailure;
    }

    if (options.parseAs === 'void' || response.status === 204) {
      return undefined as TResult;
    }
    const payload = await response.json();
    const data = unwrapProxyPayload<TResult>(payload);
    if (options.parseAs === 'text' && typeof data !== 'string') {
      return JSON.stringify(data) as TResult;
    }
    return data;
  } catch (cause) {
    if (cause instanceof WorkforceIntegrationError) {
      throw cause;
    }
    throw new WorkforceIntegrationError({
      provider: options.provider,
      operation: options.operation,
      cause,
      retryable: retryableFailure(cause)
    });
  }
}
