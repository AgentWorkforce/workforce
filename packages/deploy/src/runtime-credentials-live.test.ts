import test from 'node:test';
import assert from 'node:assert/strict';

const LIVE_RUNTIME_CREDENTIALS_URL =
  'https://agentrelay.com/cloud/api/v1/workspaces/rw_probe/runtime-credentials';

test('live runtime-credentials route rejects unauthenticated POST with 401 and GET with 405', async () => {
  const post = await fetch(LIVE_RUNTIME_CREDENTIALS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      personaId: 'runtime-credentials-live-probe',
      integrations: {},
      ttlSeconds: 3600
    })
  });
  assert.equal(post.status, 401);
  const postBody = (await post.json()) as { code?: unknown };
  assert.equal(postBody.code, 'unauthorized');

  const get = await fetch(LIVE_RUNTIME_CREDENTIALS_URL, { method: 'GET' });
  assert.equal(get.status, 405);
});
