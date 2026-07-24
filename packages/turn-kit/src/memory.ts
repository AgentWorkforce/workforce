import type { WorkforceCtx } from '@agentworkforce/runtime';
import type {
  TurnConversation,
  TurnHistoryEntry,
  TurnMemoryOptions
} from './types.js';

const DEFAULT_LIMIT = 8;
const DEFAULT_SCOPE = 'workspace';

export function conversationKey(root: string, thread?: string | number): string {
  const base = requiredIdentityPart(root, 'conversation root');
  if (thread === undefined || thread === null || String(thread).trim() === '') return base;
  return `${base}:${requiredIdentityPart(String(thread), 'conversation thread')}`;
}

export function conversationTag(namespace: string, conversation: TurnConversation): string {
  const slug = validNamespace(namespace);
  const transport = requiredIdentityPart(conversation.transport, 'conversation transport');
  const id = requiredIdentityPart(conversation.id, 'conversation id');
  return `turn:${slug}:${encodeURIComponent(transport)}:${encodeURIComponent(id)}`;
}

export async function recallTurnHistory(
  ctx: WorkforceCtx,
  tag: string,
  options: TurnMemoryOptions = {}
): Promise<TurnHistoryEntry[]> {
  const limit = positiveInteger(options.limit ?? DEFAULT_LIMIT, 'turn memory limit');
  let recalled: unknown;
  try {
    recalled = await ctx.memory.recall(options.query ?? 'recent conversation turns', {
      tags: [tag],
      limit,
      scope: options.scope ?? DEFAULT_SCOPE
    });
  } catch (error) {
    ctx.log?.('warn', 'turn-kit.memory-recall-failed', { error: String(error) });
    if (options.required) throw error;
    return [];
  }

  const entries = normalizeTurnHistory(recalled, options.recallOrder ?? 'newest-first');
  ctx.log?.('info', 'turn-kit.memory-recalled', { entries: entries.length });
  return entries;
}

export function normalizeTurnHistory(
  recalled: unknown,
  recallOrder: NonNullable<TurnMemoryOptions['recallOrder']> = 'newest-first'
): TurnHistoryEntry[] {
  if (!Array.isArray(recalled)) return [];
  const entries = recalled
    .map((item): TurnHistoryEntry | null => {
      if (typeof item === 'string') {
        const content = item.trim();
        return content ? { content } : null;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      if (typeof record.content !== 'string' || !record.content.trim()) return null;
      return {
        content: record.content,
        ...(typeof record.createdAt === 'string' && record.createdAt.trim()
          ? { createdAt: record.createdAt }
          : {})
      };
    })
    .filter((entry): entry is TurnHistoryEntry => entry !== null);

  if (entries.length > 0 && entries.every((entry) => validDate(entry.createdAt))) {
    entries.sort((left, right) =>
      String(left.createdAt).localeCompare(String(right.createdAt))
    );
  } else if (recallOrder === 'newest-first') {
    entries.reverse();
  }
  return entries;
}

export async function rememberTurn(
  ctx: WorkforceCtx,
  tag: string,
  input: string,
  reply: string,
  options: TurnMemoryOptions = {},
  content?: string
): Promise<boolean> {
  const serialized = (
    content ??
    options.serialize?.(input, reply) ??
    `${options.userLabel ?? 'User'}: ${input}\n${options.assistantLabel ?? 'Assistant'}: ${reply}`
  ).trim();
  if (!serialized) throw new TypeError('turn memory content cannot be empty');

  let receipt: { id: string } | void;
  try {
    receipt = await ctx.memory.save(serialized, {
      tags: [tag],
      scope: options.scope ?? DEFAULT_SCOPE,
      ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {})
    });
  } catch (error) {
    ctx.log?.('warn', 'turn-kit.memory-save-failed', { error: String(error) });
    if (options.required) throw error;
    return false;
  }
  if (!receipt?.id) {
    ctx.log?.('warn', 'turn-kit.memory-save-unconfirmed');
    if (options.required) {
      throw new Error('turn-kit memory save returned no receipt');
    }
    return false;
  }
  ctx.log?.('info', 'turn-kit.memory-saved', { id: receipt.id });
  return true;
}

export function validNamespace(namespace: string): string {
  const value = namespace.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(value)) {
    throw new TypeError('turn namespace must be a lowercase slug');
  }
  return value;
}

function requiredIdentityPart(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} cannot be empty`);
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be positive`);
  return value;
}

function validDate(value: string | undefined): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
