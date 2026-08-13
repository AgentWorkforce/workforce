import {
  definePersona,
  type PersonaDefinition
} from '@agentworkforce/persona-kit';

type MemoryEnabledPersona = PersonaDefinition & {
  memory: true | {
    enabled?: true;
    scopes?: Array<'workspace' | 'user' | 'global'>;
    ttlDays?: number;
    [key: string]: unknown;
  };
};

/**
 * Pass-through persona factory that makes durable conversation memory an
 * explicit authoring requirement. It intentionally leaves integrations,
 * triggers, model, sandbox, and transport capabilities to the application.
 */
export function defineTurnPersona<const T extends MemoryEnabledPersona>(input: T): T {
  const memory = input.memory as true | {
    enabled?: boolean;
    scopes?: unknown[];
  };
  if (
    memory !== true &&
    (
      memory.enabled === false ||
      (memory.scopes !== undefined && memory.scopes.length === 0)
    )
  ) {
    throw new TypeError('turn persona requires enabled memory with at least one scope');
  }
  return definePersona(input);
}
