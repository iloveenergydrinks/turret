import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRewardsServer } from '../src/http.mjs';

test('an unconfigured campaign advertises no funded rebate and has no transaction endpoint', async () => {
  const server = createRewardsServer({ config: null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${url}/v1/campaign`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'inactive', campaign: null });
    assert.equal((await fetch(`${url}/v1/publish`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${url}/v1/rewards/not-a-wallet`)).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
