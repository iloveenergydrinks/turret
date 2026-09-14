import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from '../src/runtime.mjs';
test('an inactive service starts without RPC, signing keys, or campaign funding', async () => {
  const service = await startRuntime({ config:null, port:0, host:'127.0.0.1' });
  try {
    const response = await fetch(`${service.url}/v1/campaign`);
    assert.deepEqual(await response.json(), { status:'inactive', campaign:null });
  } finally { await service.close(); }
});
