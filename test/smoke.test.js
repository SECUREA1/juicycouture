import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Uses the real built assets and HTTP server; no external services required.
test('built application serves its page, assets and APIs', async () => {
  const child = spawn(process.execPath, ['server.js'], { env: {
    ...process.env, PORT: '3099', TOKEN_MINT: '', LIVEKIT_URL: 'ws://localhost:7880',
    LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '',
  }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Server exited before startup'); })]);
    for (const [path, type, content] of [
      ['/', 'text/html', 'id="coin-name"'],
      ['/styles.css', 'text/css', 'body'],
      ['/app.js', 'text/javascript', 'coin-name'],
    ]) {
      const response = await fetch(`http://127.0.0.1:3099${path}`);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-security-policy').includes('ws://localhost:7880 http://localhost:7880'));
      assert.ok(response.headers.get('content-type').includes(type));
      assert.ok((await response.text()).includes(content));
    }
    const get = async path => (await fetch(`http://127.0.0.1:3099${path}`)).json();
    assert.deepEqual(await get('/healthz'), { ok: true });
    assert.equal((await get('/api/config')).videoReady, false);
    assert.equal((await get('/api/market')).status, 'pending');
    assert.equal((await fetch('http://127.0.0.1:3099/api/room-token', { method: 'POST' })).status, 503);
    assert.equal((await fetch('http://127.0.0.1:3099/server.js')).status, 404);
  } finally {
    child.kill();
    await once(child, 'exit');
  }
});
