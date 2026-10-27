export const NO_REPLY_MARKER = '[[NO_REPLY]]';

export const NO_REPLY_PROMPT_CONTRACT =
  `When no visible reply is useful, make the final message exactly ${NO_REPLY_MARKER}.`;

export interface SanitizedNoReplyOutput {
  output: string;
  containsMarker: boolean;
  suppressed: boolean;
}

/** Append the reserved silent-success instruction without duplicating it. */
export function appendNoReplyPromptContract(systemPrompt: string): string {
  if (systemPrompt.includes(NO_REPLY_PROMPT_CONTRACT)) return systemPrompt;
  return systemPrompt
    ? `${systemPrompt}\n\n${NO_REPLY_PROMPT_CONTRACT}`
    : NO_REPLY_PROMPT_CONTRACT;
}

/** Remove the reserved marker before harness output can reach a user-visible sink. */
export function sanitizeNoReplyOutput(output: string): SanitizedNoReplyOutput {
  const containsMarker = output.includes(NO_REPLY_MARKER);
  if (!containsMarker) return { output, containsMarker: false, suppressed: false };

  const visibleOutput = output.replaceAll(NO_REPLY_MARKER, '').trim();
  return {
    output: visibleOutput,
    containsMarker: true,
    suppressed: visibleOutput.length === 0
  };
}
