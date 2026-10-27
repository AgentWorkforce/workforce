import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCloudScheduleContext,
  createDefaultCloudScheduleContext,
  getSchedule,
  isManagedScheduleContext,
  listSchedules
} from './cloud-schedule.js';

const active = {
  id: 'schedule-1',
  name: 'call-mom',
  scheduledAt: '2026-07-30T10:00:00.000Z',
  timezone: 'Europe/Oslo',
  payload: { title: 'Call mom' },
  status: 'active',
  lastError: null,
  firedAt: null,
  cancelledAt: null,
  createdAt: '2026-07-25T10:00:00.000Z',
  updatedAt: '2026-07-25T10:00:00.000Z'
};

test('cloud schedule registers a one-shot and returns an active durable receipt', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const schedule = createCloudScheduleContext({
    baseUrl: 'https://cloud.example.test/cloud/',
    token: 'workspace-token',
    workspaceId: 'workspace/id',
    agentId: 'agent id',
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ schedule: active }, { status: 201 });
    }
  });

  const receipt = await schedule.at(
    new Date('2026-07-30T10:00:00.000Z'),
    { title: 'Call mom' },
    { name: 'call-mom', timezone: 'Europe/Oslo' }
  );

  assert.equal(receipt.id, 'schedule-1');
  assert.equal(receipt.status, 'active');
  assert.equal(
    requests[0]?.url,
    'https://cloud.example.test/cloud/api/v1/workspaces/workspace%2Fid/deployments/agent%20id/schedules'
  );
  assert.equal(requests[0]?.init?.method, 'POST');
  assert.deepEqual(
    JSON.parse(String(requests[0]?.init?.body)),
    {
      name: 'call-mom',
      scheduledAt: '2026-07-30T10:00:00.000Z',
      timezone: 'Europe/Oslo',
      payload: { title: 'Call mom' }
    }
  );
  assert.equal(
    new Headers(requests[0]?.init?.headers).get('authorization'),
    'Bearer workspace-token'
  );
});

test('cloud schedule generates a cancellable name when the caller omits one', async () => {
  const bodies: unknown[] = [];
  const schedule = createCloudScheduleContext({
    baseUrl: 'https://cloud.example.test',
    token: 'token',
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    randomUUID: () => 'uuid-1',
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        schedule: { ...active, name: 'dynamic:uuid-1', timezone: 'UTC' }
      }, { status: 201 });
    }
  });

  const receipt = await schedule.at(new Date(active.scheduledAt), {});
  assert.equal(receipt.name, 'dynamic:uuid-1');
  assert.equal((bodies[0] as { name: string }).name, 'dynamic:uuid-1');
});

test('cloud schedule rejects inactive registration receipts', async () => {
  const schedule = createCloudScheduleContext({
    baseUrl: 'https://cloud.example.test',
    token: 'token',
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    fetch: async () => Response.json({
      schedule: { ...active, status: 'pending' }
    }, { status: 201 })
  });

  await assert.rejects(
    schedule.at(new Date(active.scheduledAt), {}),
    /returned status "pending"/
  );
});

test('cloud schedule lists, gets, and cancels durable schedules', async () => {
  const requests: string[] = [];
  const schedule = createCloudScheduleContext({
    baseUrl: 'https://cloud.example.test',
    token: 'token',
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    fetch: async (input, init) => {
      requests.push(`${init?.method} ${String(input)}`);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ schedules: [active] });
    }
  });

  assert.equal((await schedule.list())[0]?.scheduledAt, active.scheduledAt);
  assert.equal((await schedule.get('schedule-1'))?.name, 'call-mom');
  assert.equal(await schedule.get('missing'), null);
  await schedule.cancel('call mom/soon');
  assert.match(requests.at(-1) ?? '', /\?name=call%20mom%2Fsoon$/);
});

test('cloud schedule ignores malformed list records while retaining valid schedules', async () => {
  const schedule = createCloudScheduleContext({
    baseUrl: 'https://cloud.example.test',
    token: 'token',
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    fetch: async () => Response.json({
      schedules: [
        { ...active, id: '' },
        active,
        { ...active, status: 'legacy' }
      ]
    })
  });

  assert.deepEqual(
    (await schedule.list()).map((record) => record.id),
    ['schedule-1']
  );
  assert.equal((await schedule.get('schedule-1'))?.name, 'call-mom');
});

test('cloud schedule surfaces provider errors and request timeouts', async () => {
  const rejected = createCloudScheduleContext({
    baseUrl: 'https://cloud.example.test',
    token: 'token',
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    fetch: async () => Response.json(
      { error: 'Deployment target is not active', code: 'inactive' },
      { status: 409 }
    )
  });
  await assert.rejects(
    rejected.at(new Date(active.scheduledAt), {}),
    /409.*Deployment target is not active/
  );

  const timedOut = createCloudScheduleContext({
    baseUrl: 'https://cloud.example.test',
    token: 'token',
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    requestTimeoutMs: 5,
    fetch: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    })
  });
  await assert.rejects(timedOut.list(), /timed out after 5ms/);
});

test('default cloud schedule requires the complete managed runner identity', () => {
  assert.equal(createDefaultCloudScheduleContext({
    env: {},
    workspaceId: 'workspace-1',
    agentId: 'agent-1'
  }), undefined);

  assert.ok(createDefaultCloudScheduleContext({
    env: {
      WORKFORCE_CLOUD_BASE_URL: 'https://cloud.example.test',
      WORKFORCE_WORKSPACE_TOKEN: 'token'
    },
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    fetch: async () => Response.json({ schedules: [] })
  }));

  assert.equal(createDefaultCloudScheduleContext({
    env: {
      WORKFORCE_CLOUD_BASE_URL: 'cloud.example.test',
      WORKFORCE_WORKSPACE_TOKEN: 'token'
    },
    workspaceId: 'workspace-1',
    agentId: 'agent-1'
  }), undefined);
});

test('managed schedule helpers narrow query support and fail clearly', async () => {
  const schedule = createCloudScheduleContext({
    baseUrl: 'https://cloud.example.test',
    token: 'token',
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    fetch: async () => Response.json({ schedules: [active] })
  });
  assert.equal(isManagedScheduleContext(schedule), true);
  assert.equal((await listSchedules(schedule))[0]?.id, 'schedule-1');
  assert.equal((await getSchedule(schedule, 'schedule-1'))?.name, 'call-mom');

  const local = {
    async at() {},
    async cancel() {}
  };
  assert.equal(isManagedScheduleContext(local), false);
  await assert.rejects(
    listSchedules(local),
    /ctx\.schedule\.list is unavailable/
  );
  await assert.rejects(
    getSchedule(local, 'schedule-1'),
    /ctx\.schedule\.get is unavailable/
  );
});
