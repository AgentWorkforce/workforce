/**
 * Optional bridge from Workforce's turn lifecycle to the canonical
 * Agent Assistant turn-context assembly contract.
 *
 * Import this module through `@agentworkforce/turn-kit/assistant` and install
 * the optional `@agent-assistant/turn-context` peer when assistant identity,
 * guardrails, provenance, or harness projection are needed.
 */
import {
  createTurnContextAssembler,
  projectToHarness,
  type TurnContextAssembler,
  type TurnContextAssembly,
  type TurnGuardrailInput,
  type TurnIdentityInput,
  type TurnSessionInput,
  type TurnShapingInput
} from '@agent-assistant/turn-context';
import { conversationTag } from './memory.js';
import type {
  TurnContext,
  TurnConversation,
  TurnHistoryEntry
} from './types.js';

export interface AssistantTurnContextInput {
  /** Stable lowercase Workforce persona/agent id. */
  assistantId: string;
  /** Unique id for this bounded turn, normally the inbound event id. */
  turnId: string;
  conversation: TurnConversation;
  /** Product-owned identity floor; never inferred from transient context. */
  identity: TurnIdentityInput;
  /** Oldest-first conversation records recalled through Workforce ctx.memory. */
  history?: readonly TurnHistoryEntry[];
  /** Exact deterministic blocks collected by Workforce context providers. */
  context?: readonly TurnContext[];
  userId?: string;
  /** Override when @agent-assistant/sessions resolved a broader assistant session. */
  sessionId?: string;
  threadId?: string;
  session?: TurnSessionInput;
  shaping?: TurnShapingInput;
  guardrails?: TurnGuardrailInput;
  metadata?: Record<string, unknown>;
}

export interface AssembleAssistantTurnContextOptions {
  /**
   * Inject a configured assembler, for example one with an Agent Assistant
   * memory retriever. When `history` is supplied it remains authoritative.
   */
  assembler?: TurnContextAssembler;
}

/**
 * Assemble Workforce history and exact provider blocks with Agent Assistant's
 * identity, guardrail, provenance, and harness projection rules.
 */
export async function assembleAssistantTurnContext(
  input: AssistantTurnContextInput,
  options: AssembleAssistantTurnContextOptions = {}
): Promise<TurnContextAssembly> {
  const assembler = options.assembler ?? createTurnContextAssembler();
  const history = input.history?.map((entry, index) => ({
    id: `${input.turnId}:history:${index + 1}`,
    text: entry.content,
    scope: 'session' as const,
    source: 'workforce-memory',
    metadata: {
      ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
      chronologicalIndex: index
    }
  }));

  const assembly = await assembler.assemble({
    assistantId: input.assistantId,
    turnId: input.turnId,
    sessionId:
      input.sessionId ??
      conversationTag(input.assistantId, input.conversation),
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    threadId: input.threadId ?? input.conversation.id,
    identity: input.identity,
    ...(input.shaping !== undefined ? { shaping: input.shaping } : {}),
    ...(input.session !== undefined ? { session: input.session } : {}),
    ...(history !== undefined ? { memory: { candidates: history } } : {}),
    ...(input.guardrails !== undefined ? { guardrails: input.guardrails } : {}),
    metadata: {
      ...(input.metadata ?? {}),
      workforceTransport: input.conversation.transport,
      workforceConversationId: input.conversation.id
    }
  });

  if (!input.context?.length) return assembly;

  const context = {
    ...assembly.context,
    blocks: [...assembly.context.blocks, ...input.context]
  };
  assertUniqueContextIds(context.blocks);

  return {
    ...assembly,
    context,
    harnessProjection: projectToHarness(
      assembly.instructions,
      context,
      input.shaping?.responseStyle
    )
  };
}

function assertUniqueContextIds(
  blocks: readonly { id: string }[]
): void {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (ids.has(block.id)) {
      throw new TypeError(`duplicate assembled turn context id: ${block.id}`);
    }
    ids.add(block.id);
  }
}

export type {
  TurnContextAssembly,
  TurnGuardrailInput,
  TurnIdentityInput,
  TurnSessionInput,
  TurnShapingInput
} from '@agent-assistant/turn-context';
