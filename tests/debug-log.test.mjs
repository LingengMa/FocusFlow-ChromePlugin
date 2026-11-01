import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
const storage = {
  local: {
    async get(key) {
      return store.has(key) ? { [key]: store.get(key) } : {};
    },
    async set(value) {
      for (const [key, item] of Object.entries(value)) store.set(key, item);
    },
    async remove(key) {
      store.delete(key);
    }
  }
};

test.beforeEach(() => {
  globalThis.chrome = { storage };
  store.clear();
});

const { appendDebugLog, clearDebugLogs, getDebugLogs } = await import('../background/debug-log.js');

test('stores AI analysis and redacts secrets', async () => {
  await appendDebugLog({
    stage: 'analysis',
    cycleId: 'c1',
    ai: {
      rawContent: '{"state":"playing"}',
      apiKey: 'should-not-be-stored'
    },
    decision: { state: 'playing' }
  });
  const logs = await getDebugLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].stage, 'analysis');
  assert.equal(logs[0].ai.rawContent, '{"state":"playing"}');
  assert.equal(logs[0].ai.apiKey, '[redacted]');
});

test('clears local logs', async () => {
  await appendDebugLog({ stage: 'result' });
  await clearDebugLogs();
  assert.equal((await getDebugLogs()).length, 0);
});
