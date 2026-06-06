#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

const HELP = `ai-hist MCP server

Exposes compacted agent trajectory JSON files over MCP stdio.

Environment:
  TRAJECTORY_ROOT  Root to scan for **/compacted/*.json files.
  AI_HIST_DB       Reserved for prompt/session history database lookup.
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trajectoryRoot(): string {
  return resolve(process.env.TRAJECTORY_ROOT || join(process.cwd(), '.trajectories'));
}

function assertInsideRoot(root: string, target: string): string {
  const resolved = resolve(root, target);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
    throw new Error('path must stay within TRAJECTORY_ROOT');
  }
  return resolved;
}

function listCompactedFiles(root: string, limit = 100): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.json') &&
        dir.split(/[/\\]/).includes('compacted')
      ) {
        out.push(relative(root, full));
      }
    }
  };
  walk(root);
  return out;
}

function result(id: JsonRpcRequest['id'], value: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result: value });
}

function error(id: JsonRpcRequest['id'], code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function send(payload: string): void {
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
}

function textContent(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

function handle(request: JsonRpcRequest): string | null {
  const id = request.id ?? null;
  switch (request.method) {
    case 'initialize':
      return result(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ai-hist', version: '0.1.0' }
      });
    case 'notifications/initialized':
      return null;
    case 'tools/list':
      return result(id, {
        tools: [
          {
            name: 'list_trajectories',
            description: 'List compacted trajectory JSON files under TRAJECTORY_ROOT.',
            inputSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number', minimum: 1, maximum: 500 }
              }
            }
          },
          {
            name: 'read_trajectory',
            description: 'Read one compacted trajectory JSON file by path from list_trajectories.',
            inputSchema: {
              type: 'object',
              properties: {
                path: { type: 'string' }
              },
              required: ['path']
            }
          }
        ]
      });
    case 'tools/call': {
      const params = isRecord(request.params) ? request.params : {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const root = trajectoryRoot();
      if (name === 'list_trajectories') {
        const rawLimit = args.limit;
        const limit =
          typeof rawLimit === 'number' && Number.isFinite(rawLimit)
            ? Math.max(1, Math.min(500, Math.trunc(rawLimit)))
            : 100;
        return result(id, textContent(JSON.stringify(listCompactedFiles(root, limit), null, 2)));
      }
      if (name === 'read_trajectory') {
        if (typeof args.path !== 'string' || !args.path) {
          return error(id, -32602, 'read_trajectory requires arguments.path');
        }
        const target = assertInsideRoot(root, args.path);
        if (!statSync(target).isFile()) {
          return error(id, -32602, 'path is not a file');
        }
        return result(id, textContent(readFileSync(target, 'utf8')));
      }
      return error(id, -32601, `unknown tool: ${name}`);
    }
    default:
      return error(id, -32601, `unknown method: ${request.method ?? '(missing)'}`);
  }
}

function parseFrames(buffer: Buffer): { messages: JsonRpcRequest[]; rest: Buffer } {
  const messages: JsonRpcRequest[] = [];
  let rest = buffer;
  while (true) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = rest.subarray(0, headerEnd).toString('utf8');
    const match = /^Content-Length:\s*(\d+)$/im.exec(header);
    if (!match) {
      throw new Error('missing Content-Length header');
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (rest.length < bodyEnd) break;
    messages.push(JSON.parse(rest.subarray(bodyStart, bodyEnd).toString('utf8')));
    rest = rest.subarray(bodyEnd);
  }
  return { messages, rest };
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
  try {
    buffer = Buffer.concat([buffer, chunk]);
    const parsed = parseFrames(buffer);
    buffer = parsed.rest;
    for (const message of parsed.messages) {
      const response = handle(message);
      if (response) send(response);
    }
  } catch (err) {
    send(error(null, -32700, err instanceof Error ? err.message : String(err)));
  }
});
