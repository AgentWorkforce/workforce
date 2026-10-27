import type { WorkforceCtx } from '@agentworkforce/runtime';

export interface ConfirmedTurnActionOptions<Receipt, Result> {
  ctx?: WorkforceCtx;
  /** Stable, non-sensitive action name for logs and errors. */
  name: string;
  perform(): Receipt | Promise<Receipt>;
  confirm(receipt: Receipt): boolean;
  /**
   * Construct the user-visible success value only after confirmation. This
   * prevents optimistic "Done" text from escaping before a provider receipt.
   */
  confirmed(receipt: Receipt): Result;
}

export class UnconfirmedTurnActionError extends Error {
  constructor(action: string) {
    super(`turn action "${action}" returned an unconfirmed provider receipt`);
    this.name = 'UnconfirmedTurnActionError';
  }
}

export async function runConfirmedTurnAction<Receipt, Result>(
  options: ConfirmedTurnActionOptions<Receipt, Result>
): Promise<Result> {
  const name = options.name.trim();
  if (!name) throw new TypeError('turn action name is required');
  const receipt = await options.perform();
  if (!options.confirm(receipt)) {
    options.ctx?.log?.('error', 'turn-kit.action-unconfirmed', { action: name });
    throw new UnconfirmedTurnActionError(name);
  }
  options.ctx?.log?.('info', 'turn-kit.action-confirmed', { action: name });
  return options.confirmed(receipt);
}
