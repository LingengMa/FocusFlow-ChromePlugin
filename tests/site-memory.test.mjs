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
    }
  }
};

test.beforeEach(() => {
  globalThis.chrome = { storage };
  store.clear();
});

const { getSiteMemory, recordSiteActions } = await import('../background/site-memory.js');

test('learns successful visual coordinates per host', async () => {
  const memory = await recordSiteActions('https://course.example.test/lesson/1', [
    { type: 'click_at', target: '播放按钮', x: 0.5, y: 0.5 },
    { type: 'scroll_at', target: '右侧目录', x: 0.9, y: 0.55, deltaY: 620 }
  ], { title: '课程' });
  assert.ok(memory);
  assert.equal(memory.actions.length, 2);
  assert.equal(memory.pageTitle, '课程');

  const loaded = await getSiteMemory('https://course.example.test/lesson/2');
  assert.equal(loaded.actions.length, 2);
  assert.equal(loaded.actions[1].deltaY, 620);
});

test('updates an existing target instead of duplicating it', async () => {
  await recordSiteActions('https://course.example.test/lesson/1', [
    { type: 'click_at', target: '播放按钮', x: 0.5, y: 0.5 }
  ]);
  await recordSiteActions('https://course.example.test/lesson/1', [
    { type: 'click_at', target: '播放按钮', x: 0.52, y: 0.48 }
  ]);
  const memory = await getSiteMemory('https://course.example.test/lesson/1');
  assert.equal(memory.actions.length, 1);
  assert.equal(memory.actions[0].x, 0.52);
});
