import {
  definePersona,
  type Harness,
  type HarnessSettings,
  type PersonaMemory
} from '@agentworkforce/persona-kit';
import type { GitHubRepository } from './types.js';

export interface DefineReviewPersonaOptions<Lens extends string = string> {
  repo: GitHubRepository;
  lens: Lens;
  systemPrompt: string;
  id?: string;
  description?: string;
  harness?: Harness;
  model?: string;
  harnessSettings?: HarnessSettings;
  onEvent?: string;
  /** Opt-in only: deterministic reviews do not need memory by default. */
  memory?: PersonaMemory;
  /** Git history depth requested during cloud PR checkout. */
  fetchDepth?: number | 'full';
}

/**
 * Emit the read-only persona half of a review agent. Since cloud#2664,
 * `writeback: false` still receives clone-only credentials for private repos;
 * it prevents harness edits from ever being pushed back to the PR branch.
 */
export function defineReviewPersona<const Lens extends string>(
  options: DefineReviewPersonaOptions<Lens>
) {
  if (!options.systemPrompt.trim()) throw new TypeError('review persona systemPrompt is required');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(options.lens)) {
    throw new TypeError('review lens must be a lowercase slug');
  }
  if (
    options.fetchDepth !== undefined &&
    options.fetchDepth !== 'full' &&
    (!Number.isInteger(options.fetchDepth) || options.fetchDepth <= 0)
  ) {
    throw new TypeError('review persona fetchDepth must be a positive integer or "full"');
  }

  const id = options.id ?? `${options.lens}-reviewer`;
  return definePersona({
    id,
    intent: 'review',
    tags: ['review'],
    description:
      options.description ??
      `Reviews ${options.repo} pull requests through the ${options.lens} lens. Comments only; never edits.`,
    cloud: true,
    // Review idempotency scans mounted canonical comments, and evidence
    // providers consume the materialized PR checkout.
    sandbox: true,
    useSubscription: true,
    capabilities: {
      pullRequest: {
        enabled: true,
        writeback: false,
        ...(options.fetchDepth !== undefined ? { fetchDepth: options.fetchDepth } : {})
      }
    },
    integrations: {
      github: { scope: { repo: options.repo } }
    },
    inputs: {
      SKIP_LABELS: {
        description: `Comma-separated PR labels that disable the ${options.lens} reviewer.`,
        env: 'SKIP_LABELS',
        optional: true
      }
    },
    harness: options.harness ?? 'claude',
    model: options.model ?? 'claude-opus-4-8',
    systemPrompt: options.systemPrompt,
    harnessSettings: options.harnessSettings ?? {
      reasoning: 'high',
      timeoutSeconds: 2400
    },
    ...(options.memory !== undefined ? { memory: options.memory } : {}),
    onEvent: options.onEvent ?? './agent.ts'
  });
}
