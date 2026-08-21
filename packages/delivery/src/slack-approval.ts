import type { SlackReaction } from './slack.js';

const APPROVAL_METADATA_EVENT = 'agentworkforce_slack_approval_v1';
const MAX_EVENT_PAYLOAD_CHARACTERS = 3_000;
const MAX_METADATA_BYTES = 3_800;
const MAX_BLOCK_ID_BYTES = 255;
const MAX_BLOCKS = 50;
const MAX_SECTION_TEXT = 2_900;

export interface SlackApprovalCardOptions {
  /** Stable agent/action namespace, for example `github-inbox.archive`. */
  namespace: string;
  /** The only Slack member allowed to approve this card. */
  approverId: string;
  /** Exact non-secret opaque identifiers the approved action will receive. */
  actionIds: readonly string[];
  /** User-visible Slack mrkdwn. Action identifiers are never appended to it. */
  text: string;
  /** Optional non-secret state used when interpreting the action. */
  context?: Record<string, unknown>;
  /** Optional domain validator applied before identifiers enter the card. */
  validateActionId?: (id: string) => boolean;
}

export interface SlackApprovalCard {
  text: string;
  metadata: {
    event_type: typeof APPROVAL_METADATA_EVENT;
    event_payload: {
      namespace: string;
      approver_id: string;
      action_ids: string[];
      context?: Record<string, unknown>;
    };
  };
  blocks: Array<Record<string, unknown>>;
}

export interface ReadSlackApprovalOptions {
  namespace: string;
  approverId: string;
  validateActionId?: (id: string) => boolean;
}

export interface MatchSlackApprovalOptions extends ReadSlackApprovalOptions {
  /** Slack emoji name, with or without surrounding colons. */
  emoji?: string;
  /** Required Slack app id of the card author, for example `A012345678`. */
  appId: string;
}

export interface SlackApproval {
  namespace: string;
  approverId: string;
  actionIds: string[];
  context?: Record<string, unknown>;
}

/**
 * Build a Slack approval card whose exact action identifiers are non-rendered
 * message state rather than visible text. They are not encrypted and must not
 * contain secrets.
 *
 * Identifiers are stored in message metadata and redundantly encoded into
 * non-rendered block ids. The block copy lets an agent recover safely when
 * Slack returns the metadata event type but redacts its payload. Every Slack
 * size limit is checked before the card is returned.
 */
export function buildSlackApprovalCard(
  options: SlackApprovalCardOptions
): SlackApprovalCard {
  const { namespace, approverId } = approvalIdentity(options);
  if (!options.text.trim()) throw new Error('Slack approval card text is required');
  const actionIds = normalizeActionIds(options.actionIds, options.validateActionId);
  if (actionIds.length === 0) {
    throw new Error('Slack approval card requires at least one action id');
  }

  const eventPayload: SlackApprovalCard['metadata']['event_payload'] = {
    namespace,
    approver_id: approverId,
    action_ids: actionIds,
    ...(options.context ? { context: options.context } : {})
  };
  const metadata: SlackApprovalCard['metadata'] = {
    event_type: APPROVAL_METADATA_EVENT,
    event_payload: eventPayload
  };
  const encodedEventPayload = stringifyApprovalJson(eventPayload, 'event payload');
  if (textLength(encodedEventPayload) > MAX_EVENT_PAYLOAD_CHARACTERS) {
    throw new Error(
      `Slack approval event payload is too large (${textLength(encodedEventPayload)} characters)`
    );
  }
  const encodedMetadata = stringifyMetadata(metadata);
  if (Buffer.byteLength(encodedMetadata, 'utf8') > MAX_METADATA_BYTES) {
    throw new Error(
      `Slack approval metadata is too large (${Buffer.byteLength(encodedMetadata, 'utf8')} bytes)`
    );
  }

  const blocks: Array<Record<string, unknown>> = splitSlackSectionText(options.text).map((text) => ({
    type: 'section',
    text: { type: 'mrkdwn', text }
  }));
  for (const blockId of approvalBlockIds(namespace, approverId, actionIds)) {
    blocks.push({
      type: 'context',
      block_id: blockId,
      elements: [{ type: 'plain_text', text: '\u2063', emoji: false }]
    });
  }
  if (blocks.length > MAX_BLOCKS) {
    throw new Error(`Slack approval card requires too many blocks (${blocks.length})`);
  }
  return { text: options.text, metadata, blocks };
}

/**
 * Decode action identifiers from a Slack message created by
 * {@link buildSlackApprovalCard}. The expected namespace and approver are
 * caller-supplied, so a card for another action or user cannot be replayed.
 *
 * Metadata and block-id copies are combined when both are present. Malformed
 * identifiers fail the entire card rather than being silently discarded.
 */
export function readSlackApproval(
  message: unknown,
  options: ReadSlackApprovalOptions
): SlackApproval | null {
  const { namespace, approverId } = approvalIdentity(options);
  const record = asRecord(message);
  if (!record) return null;

  const metadata = asRecord(record.metadata);
  const eventPayload = asRecord(metadata?.event_payload);
  const standardMetadata = metadata?.event_type === APPROVAL_METADATA_EVENT;
  if (!standardMetadata) return null;
  const metadataHasIdentity = eventPayload !== null && (
    'namespace' in eventPayload || 'approver_id' in eventPayload
  );
  const metadataMatches = standardMetadata
    && eventPayload?.namespace === namespace
    && eventPayload.approver_id === approverId;

  // A standard card that names a different action/user is inconsistent with
  // the requested approval, even if somebody also inserted a matching block.
  if (standardMetadata && metadataHasIdentity && !metadataMatches) return null;

  let metadataIds: string[] | null = null;
  if (metadataMatches && 'action_ids' in eventPayload) {
    if (!Array.isArray(eventPayload.action_ids)) return null;
    if (!eventPayload.action_ids.every((id) => typeof id === 'string')) return null;
    metadataIds = normalizeDecodedActionIds(
      eventPayload.action_ids,
      options.validateActionId
    );
    if (!metadataIds || metadataIds.length === 0) return null;
  }

  const prefix = approvalBlockPrefix(namespace, approverId);
  let matchingBlock = false;
  const blockIds: string[] = [];
  const blocks = Array.isArray(record.blocks) ? record.blocks : [];
  for (const value of blocks) {
    const block = asRecord(value);
    const blockId = typeof block?.block_id === 'string' ? block.block_id : undefined;
    if (!blockId?.startsWith(prefix)) continue;
    matchingBlock = true;
    const decoded = decodeBlockIds(blockId.slice(prefix.length));
    if (!decoded) return null;
    blockIds.push(...decoded);
  }

  if (!metadataMatches && !matchingBlock) return null;
  const normalizedBlockIds = matchingBlock
    ? normalizeDecodedActionIds(blockIds, options.validateActionId)
    : null;
  if (matchingBlock && (!normalizedBlockIds || normalizedBlockIds.length === 0)) return null;
  if (metadataIds && normalizedBlockIds && !sameStrings(metadataIds, normalizedBlockIds)) {
    return null;
  }
  const actionIds = metadataIds ?? normalizedBlockIds;
  if (!actionIds) return null;
  const context = metadataMatches ? asRecord(eventPayload.context) : null;
  return {
    namespace,
    approverId,
    actionIds,
    ...(context ? { context } : {})
  };
}

/**
 * Bind a decoded card to the exact reaction that approved it.
 *
 * Callers fetch the reacted message using `reaction.channel` and
 * `reaction.messageTs`, then pass that result here. A different actor, emoji,
 * or message timestamp fails closed.
 */
export function matchSlackApprovalReaction(
  reaction: SlackReaction,
  message: unknown,
  options: MatchSlackApprovalOptions
): SlackApproval | null {
  const emoji = normalizeEmoji(options.emoji ?? 'white_check_mark');
  if (
    reaction.action !== 'added'
    || reaction.actorId !== options.approverId
    || reaction.emoji !== emoji
  ) return null;
  const messageRecord = asRecord(message);
  if (typeof messageRecord?.ts !== 'string' || messageRecord.ts !== reaction.messageTs) {
    return null;
  }
  const botProfile = asRecord(messageRecord.bot_profile);
  const messageAppId = typeof messageRecord.app_id === 'string'
    ? messageRecord.app_id
    : typeof botProfile?.app_id === 'string'
      ? botProfile.app_id
      : undefined;
  if (!options.appId.trim() || messageAppId !== options.appId) return null;
  return readSlackApproval(message, options);
}

function approvalIdentity(options: {
  namespace: string;
  approverId: string;
}): { namespace: string; approverId: string } {
  const namespace = options.namespace.trim();
  const approverId = options.approverId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(namespace)) {
    throw new Error('Slack approval namespace must be 1-64 URL-safe characters');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(approverId)) {
    throw new Error('Slack approval approver id must be 1-128 URL-safe characters');
  }
  return { namespace, approverId };
}

function normalizeActionIds(
  values: readonly string[],
  validate: ((id: string) => boolean) | undefined
): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const id = value.trim();
    if (!id || validate?.(id) === false) {
      throw new Error(`Invalid Slack approval action id: ${JSON.stringify(value)}`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      output.push(id);
    }
  }
  return output;
}

function normalizeDecodedActionIds(
  values: readonly string[],
  validate: ((id: string) => boolean) | undefined
): string[] | null {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const id = value.trim();
    if (!id || validate?.(id) === false) return null;
    if (!seen.has(id)) {
      seen.add(id);
      output.push(id);
    }
  }
  return output;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function approvalBlockIds(
  namespace: string,
  approverId: string,
  actionIds: readonly string[]
): string[] {
  const prefix = approvalBlockPrefix(namespace, approverId);
  const output: string[] = [];
  let chunk: string[] = [];
  for (const id of actionIds) {
    const encoded = encodeURIComponent(id);
    const candidate = `${prefix}${[...chunk, encoded].join(',')}`;
    if (Buffer.byteLength(candidate, 'utf8') <= MAX_BLOCK_ID_BYTES) {
      chunk.push(encoded);
      continue;
    }
    if (chunk.length === 0) {
      throw new Error(`Slack approval action id is too large for a block id: ${JSON.stringify(id)}`);
    }
    output.push(`${prefix}${chunk.join(',')}`);
    chunk = [encoded];
    if (Buffer.byteLength(`${prefix}${encoded}`, 'utf8') > MAX_BLOCK_ID_BYTES) {
      throw new Error(`Slack approval action id is too large for a block id: ${JSON.stringify(id)}`);
    }
  }
  if (chunk.length > 0) output.push(`${prefix}${chunk.join(',')}`);
  return output;
}

function approvalBlockPrefix(namespace: string, approverId: string): string {
  return `aw-approval-v1:${namespace}:${approverId}:`;
}

function decodeBlockIds(value: string): string[] | null {
  if (!value) return null;
  try {
    const encoded = value.split(',');
    if (encoded.some((id) => !id)) return null;
    return encoded.map((id) => decodeURIComponent(id));
  } catch {
    return null;
  }
}

function splitSlackSectionText(text: string): string[] {
  const output: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (textLength(candidate) <= MAX_SECTION_TEXT) {
      current = candidate;
      continue;
    }
    if (current) {
      output.push(current);
      current = '';
    }
    const pieces = splitLongText(line, MAX_SECTION_TEXT);
    output.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? '';
  }
  if (current) output.push(current);
  return output;
}

function splitLongText(text: string, limit: number): string[] {
  const characters = Array.from(text);
  if (characters.length <= limit) return [text];
  const output: string[] = [];
  for (let offset = 0; offset < characters.length; offset += limit) {
    output.push(characters.slice(offset, offset + limit).join(''));
  }
  return output;
}

function textLength(text: string): number {
  return Array.from(text).length;
}

function stringifyMetadata(metadata: SlackApprovalCard['metadata']): string {
  return stringifyApprovalJson(metadata, 'metadata');
}

function stringifyApprovalJson(value: unknown, label: string): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `Slack approval ${label} is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function normalizeEmoji(value: string): string {
  return value.trim().replaceAll(':', '');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
