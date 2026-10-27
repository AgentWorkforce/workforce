interface PersonaRefFields {
  slug?: string;
  version?: number | string;
  path?: string;
  inline?: Record<string, unknown>;
}

/** Object refs require at least one resolvable selector, matching the parser/schema. */
export type PersonaRef = string | (PersonaRefFields & (
  | { slug: string }
  | { path: string }
  | { inline: Record<string, unknown> }
));

export type TriggerSelector = Record<string, unknown>;
export type DelegationRule = Record<string, unknown>;

export interface TeamMember {
  name: string;
  persona: PersonaRef;
  role?: string;
  owns?: TriggerSelector[];
}

export interface TeamSpec {
  id: string;
  lead: string;
  members: TeamMember[];
  delegation?: DelegationRule[];
  tokenBudget?: number;
  timeBudgetSeconds?: number;
}

export type TeamRef =
  | string
  | {
      id: string;
      version?: string | number;
      path?: string;
    };

/** Relayflows is referenced, never copied into this package. */
export type ComposeRef =
  | { kind: 'team'; ref: TeamRef }
  | { kind: 'workflow'; ref: string; version?: string | number };

export interface ComposePlanNodeV1 {
  id: string;
  kind: 'lead' | 'member' | 'workflow-step';
  persona?: PersonaRef;
  role?: string;
  owns?: TriggerSelector[];
  extensions?: Record<string, unknown>;
}

export interface ComposePlanEdgeV1 {
  from: string;
  to: string;
  kind: 'delegates' | 'depends-on';
  reason?: string;
}

interface ComposePlanBaseV1 {
  schemaVersion: 1;
  composeId: string;
  status: 'valid' | 'invalid';
  nodes: ComposePlanNodeV1[];
  edges: ComposePlanEdgeV1[];
  delegation?: DelegationRule[];
  budget?: { tokenBudget?: number; timeBudgetSeconds?: number };
  errors: string[];
  extensions?: Record<string, unknown>;
}

/** Plan kind and reference stay correlated across serialization boundaries. */
export type ComposePlanV1 = ComposePlanBaseV1 & (
  | { kind: 'team'; ref: Extract<ComposeRef, { kind: 'team' }> }
  | { kind: 'workflow'; ref: Extract<ComposeRef, { kind: 'workflow' }> }
);

export interface ComposeResultV1 {
  schemaVersion: 1;
  composeId: string;
  status: 'previewed' | 'succeeded' | 'failed' | 'cancelled';
  plan: ComposePlanV1;
  childRunIds: string[];
  tokenBudgetConsumed?: number;
  timeConsumedSeconds?: number;
  errors?: string[];
  extensions?: Record<string, unknown>;
}
