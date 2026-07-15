export type PersonaRef =
  | string
  | {
      slug?: string;
      version?: number | string;
      path?: string;
      inline?: Record<string, unknown>;
    };

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

export interface ComposePlanV1 {
  schemaVersion: 1;
  composeId: string;
  kind: ComposeRef['kind'];
  ref: ComposeRef;
  status: 'valid' | 'invalid';
  nodes: ComposePlanNodeV1[];
  edges: ComposePlanEdgeV1[];
  budget?: { tokenBudget?: number; timeBudgetSeconds?: number };
  errors: string[];
  extensions?: Record<string, unknown>;
}

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
