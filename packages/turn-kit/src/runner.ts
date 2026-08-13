import type { WorkforceCtx } from '@agentworkforce/runtime';
import packageJson from '../package.json' with { type: 'json' };
import { collectTurnContext } from './context.js';
import {
  conversationTag,
  recallTurnHistory,
  rememberTurn,
  validNamespace
} from './memory.js';
import type {
  TurnRequest,
  TurnResponse,
  TurnRunResult,
  TurnRunner,
  TurnRunnerOptions
} from './types.js';

/** Read at bundle/install time so deployed logs expose the bundled kit version. */
export const TURN_KIT_VERSION = packageJson.version;

export class UnconfirmedTurnDeliveryError extends Error {
  constructor(namespace: string) {
    super(`${namespace} final turn delivery returned an unconfirmed receipt`);
    this.name = 'UnconfirmedTurnDeliveryError';
  }
}

/**
 * Compose the portable lifecycle shared by conversational agents:
 * recall → deterministic context → respond/ack → confirmed final delivery →
 * remember. Transport parsing, domain actions, and exact state stay outside.
 */
export function createTurnRunner(
  options: TurnRunnerOptions
): TurnRunner {
  const namespace = validNamespace(options.namespace);
  const memory = options.memory === false ? false : options.memory ?? {};
  const providers = [...(options.context ?? [])];

  return {
    async run<Receipt>(
      ctx: WorkforceCtx,
      request: TurnRequest<Receipt>
    ): Promise<TurnRunResult<Receipt>> {
      const input = request.input.trim();
      if (!input) throw new TypeError('turn input cannot be empty');
      const tag = conversationTag(namespace, request.conversation);
      ctx.log?.('info', 'turn-kit.started', {
        version: TURN_KIT_VERSION,
        namespace,
        transport: request.conversation.transport
      });

      const history = memory === false
        ? []
        : await recallTurnHistory(ctx, tag, memory);
      const context = await collectTurnContext(providers, {
        ctx,
        conversation: request.conversation,
        input,
        history
      });

      let acknowledgements = 0;
      const acknowledge = async (message: string): Promise<boolean> => {
        const text = message.trim();
        if (!text || !request.acknowledge) return false;
        try {
          await request.acknowledge(text);
          acknowledgements += 1;
          ctx.log?.('info', 'turn-kit.acknowledged', { namespace });
          return true;
        } catch (error) {
          ctx.log?.('warn', 'turn-kit.acknowledgement-failed', {
            namespace,
            error: String(error)
          });
          return false;
        }
      };

      const response = normalizeResponse(
        await request.respond({
          ctx,
          conversation: request.conversation,
          input,
          history,
          context,
          acknowledge
        })
      );

      const receipt = await request.deliver(response.reply);
      if (request.confirmDelivery && !request.confirmDelivery(receipt)) {
        ctx.log?.('error', 'turn-kit.delivery-unconfirmed', { namespace });
        throw new UnconfirmedTurnDeliveryError(namespace);
      }

      const memorySaved =
        memory !== false && response.remember !== false
          ? await rememberTurn(
              ctx,
              tag,
              input,
              response.reply,
              memory,
              typeof response.remember === 'string' ? response.remember : undefined
            )
          : false;

      ctx.log?.('info', 'turn-kit.completed', {
        namespace,
        acknowledgements,
        context: context.length,
        memorySaved
      });
      return {
        reply: response.reply,
        receipt,
        context,
        acknowledgements,
        memorySaved
      };
    }
  };
}

function normalizeResponse(value: string | TurnResponse): TurnResponse {
  const response = typeof value === 'string' ? { reply: value } : value;
  const reply = response.reply.trim();
  if (!reply) throw new TypeError('turn response cannot be empty');
  if (typeof response.remember === 'string' && !response.remember.trim()) {
    throw new TypeError('explicit turn memory cannot be empty');
  }
  return { ...response, reply };
}
