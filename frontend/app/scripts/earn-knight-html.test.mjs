import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEarnKnight } from './earn-knight-html.mjs';
test('the shared shell loads the enhancer once and preserves the application', () => {
  const html='<html><head><title>Earn</title></head><body><main>Pool controls</main><script src="/existing.js"></script></body></html>';
  const output=withEarnKnight(html);
  assert.match(output,/earn-knight-20260912\/entry.js/);
  assert.ok(output.includes('<main>Pool controls</main><script src="/existing.js"></script>'));
  assert.equal(withEarnKnight(output),output);
});
