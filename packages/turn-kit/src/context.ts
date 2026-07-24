import type {
  TurnContext,
  TurnContextProvider,
  TurnContextProviderArgs
} from './types.js';

/** Identity helper that preserves a custom provider's literal name in its type. */
export function defineTurnContext<const Name extends string>(
  provider: TurnContextProvider<Name>
): TurnContextProvider<Name> {
  if (!provider.name.trim()) throw new TypeError('turn context provider name is required');
  return provider;
}

export async function collectTurnContext(
  providers: readonly TurnContextProvider[],
  args: TurnContextProviderArgs
): Promise<TurnContext[]> {
  const collected = await Promise.all(
    providers.map(async (provider): Promise<TurnContext[]> => {
      try {
        const result = await provider.collect(args);
        return normalizeContext(result, provider.name);
      } catch (error) {
        args.ctx.log?.(
          provider.optional ? 'warn' : 'error',
          'turn-kit.context-provider-failed',
          { provider: provider.name, optional: Boolean(provider.optional), error: String(error) }
        );
        if (!provider.optional) throw error;
        return [];
      }
    })
  );
  const context = collected.flat();
  args.ctx.log?.('info', 'turn-kit.context-collected', {
    providers: providers.length,
    sections: context.length
  });
  return context;
}

function normalizeContext(
  value: TurnContext | readonly TurnContext[] | null | undefined,
  provider: string
): TurnContext[] {
  const entries = value === null || value === undefined
    ? []
    : Array.isArray(value)
      ? value
      : [value];
  return entries.map((entry) => {
    const title = entry.title.trim();
    const content = entry.content.trim();
    if (!title || !content) {
      throw new TypeError(`turn context provider ${provider} returned an empty section`);
    }
    return { title, content };
  });
}
