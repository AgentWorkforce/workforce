import type {
  EffectPolicyV1,
  PreviewAction,
  RunRecordV2,
  RunRequestV1
} from './run-contracts.js';
import type { MemoryItem } from './types.js';

export interface LocalHttpFixture {
  method: string;
  match: string;
  body: string;
  contentType?: string;
  sourcePath?: string;
}

export interface LocalPreviewMemoryEntry extends MemoryItem {
  scope: 'workspace' | 'user' | 'global';
}

export interface LocalPreviewState {
  files?: Record<string, string>;
  memory?: LocalPreviewMemoryEntry[];
}

export interface ExecuteLocalRunOptions {
  request: RunRequestV1;
  bundlePath: string;
  sourcePath?: string;
  inputs?: Record<string, string>;
  state?: LocalPreviewState;
  httpFixtures?: readonly LocalHttpFixture[];
  replayProvenance?: Record<string, unknown>;
  now?: () => Date;
}

export interface ExecuteLocalRunResult {
  record: RunRecordV2;
  exitCode: 0 | 1;
  logs: string[];
  state: LocalPreviewState;
}

export interface LocalPreviewGuardConfig {
  policy: EffectPolicyV1;
  fixtures: readonly LocalHttpFixture[];
  clockNow?: string;
}

export interface LocalPreviewWorkerPayload {
  request: RunRequestV1;
  bundlePath: string;
  inputs?: Record<string, string>;
  state?: LocalPreviewState;
  replayProvenance?: Record<string, unknown>;
}

export interface LocalPreviewWorkerSuccess extends ExecuteLocalRunResult {
  ok: true;
}

export interface LocalPreviewWorkerFailure {
  ok: false;
  error: string;
  stack?: string;
}

export type LocalPreviewWorkerResult = LocalPreviewWorkerSuccess | LocalPreviewWorkerFailure;

export interface PreviewProcessState {
  activateUserImportGuard: () => void;
  cleanup: () => void;
  now: () => Date;
  previewTransport: {
    actions: PreviewAction[];
    accesses: PreviewAction[];
  };
  recordAction: (action: PreviewAction) => void;
  recordedActions: PreviewAction[];
}
