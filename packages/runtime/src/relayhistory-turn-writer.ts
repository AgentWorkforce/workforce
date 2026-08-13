export type RelayhistoryTurnRole = 'user' | 'assistant' | 'system';
export type RelayhistoryActorRole = 'owner' | 'steerer';

export interface RelayhistoryTurnWriterOptions {
  relaySessionId: string;
  sessionOwner: string;
  actorName: string;
  relayhistoryUrl?: string;
  orgId: string;
}

export interface RelayhistoryTurnInput {
  role: RelayhistoryTurnRole;
  content: string;
  actorName?: string;
  actorRole?: RelayhistoryActorRole;
}

export interface RelayhistorySessionMetadataInput {
  nativeCli: 'claude' | 'codex';
  nativeResumeId?: string;
}

interface RelayhistoryTurnPayload {
  role: RelayhistoryTurnRole;
  content: string;
  actorName: string;
  actorRole: RelayhistoryActorRole;
  turnIndex: number;
  metadata: Record<string, unknown>;
  ts: string;
}

/**
 * Best-effort conversation journal for relayhistory-cloud.
 *
 * Calls deliberately return before the network request finishes. Relayhistory
 * is observability: an unavailable history service must never delay or fail the
 * harness session it records.
 */
export class RelayhistoryTurnWriter {
  private readonly relaySessionId: string;
  private readonly sessionOwner: string;
  private readonly actorName: string;
  private readonly relayhistoryUrl?: string;
  private readonly orgId: string;
  private nextTurnIndex = 0;

  constructor(options: RelayhistoryTurnWriterOptions) {
    this.relaySessionId = options.relaySessionId;
    this.sessionOwner = options.sessionOwner;
    this.actorName = options.actorName;
    this.relayhistoryUrl = normalizeBaseUrl(
      options.relayhistoryUrl ?? process.env.RELAYHISTORY_URL
    );
    this.orgId = options.orgId;
  }

  writeTurn(input: RelayhistoryTurnInput): void {
    this.postTurn({
      role: input.role,
      content: input.content,
      actorName: input.actorName ?? this.actorName,
      actorRole: input.actorRole ?? defaultActorRole(input.role),
      turnIndex: this.nextTurnIndex++,
      metadata: {},
      ts: new Date().toISOString()
    });
  }

  /**
   * Relayhistory derives session metadata from turn metadata. Record a silent
   * system turn so metadata is immediately available even before the first
   * user/assistant pair completes.
   */
  writeSessionMetadata(input: RelayhistorySessionMetadataInput): void {
    this.postTurn({
      role: 'system',
      content: '',
      actorName: this.actorName,
      actorRole: 'steerer',
      turnIndex: this.nextTurnIndex++,
      metadata: {
        nativeCli: input.nativeCli,
        ...(input.nativeResumeId ? { nativeResumeId: input.nativeResumeId } : {})
      },
      ts: new Date().toISOString()
    });
  }

  private postTurn(turn: RelayhistoryTurnPayload): void {
    if (!this.relayhistoryUrl) return;

    const accessToken =
      process.env.RELAYHISTORY_ACCESS_TOKEN ?? process.env.RELAYHISTORY_TOKEN;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Org-Id': this.orgId
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const url =
      `${this.relayhistoryUrl}/v1/sessions/` +
      `${encodeURIComponent(this.relaySessionId)}/turns`;
    void fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionOwner: this.sessionOwner,
        turns: [turn]
      })
    })
      .then(async (response) => {
        if (response.ok) return;
        const detail = await response.text().catch(() => '');
        throw new Error(
          `${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`
        );
      })
      .catch((error: unknown) => {
        console.error(
          `[relayhistory] failed to write turn ${turn.turnIndex} for session ` +
            `${this.relaySessionId}: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, '');
  return trimmed || undefined;
}

function defaultActorRole(role: RelayhistoryTurnRole): RelayhistoryActorRole {
  return role === 'user' ? 'owner' : 'steerer';
}
