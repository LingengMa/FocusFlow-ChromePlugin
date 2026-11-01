import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.chrome = {
  storage: {
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
  }
};

const {
  getEffectiveSettings,
  getSelfHealProfile,
  recordActionResults,
  recordApiFailure,
  recordQuizRetryLimit
} = await import('../background/self-heal.js');

const COURSE_URL = 'https://course.example.test/lesson/1';
const baseSettings = {
  selfHeal: true,
  clickMode: 'hybrid',
  intervalSeconds: 45
};

test.beforeEach(() => {
  globalThis.chrome = {
    storage: {
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
    }
  };
  store.clear();
});

test('keeps vision mode and asks for a coordinate retry after failures', async () => {
  const first = await recordActionResults(COURSE_URL, [
    { type: 'click_at', ok: false, detail: 'coordinate miss' }
  ]);
  assert.equal(first, null);

  const second = await recordActionResults(COURSE_URL, [
    { type: 'click_at', ok: false, detail: 'coordinate miss' }
  ]);
  assert.equal(second.action, 'retry-vision');
  assert.equal(second.mode, 'vision');

  const effective = await getEffectiveSettings(baseSettings, COURSE_URL);
  assert.equal(effective.clickMode, 'vision');
  assert.equal((await getSelfHealProfile(COURSE_URL)).lastDiagnosis.includes('视觉点击'), true);
});

test('legacy DOM failures do not switch away from vision', async () => {
  await recordActionResults(COURSE_URL, [{ type: 'choose', ok: false }]);
  const diagnosis = await recordActionResults(COURSE_URL, [{ type: 'choose', ok: false }]);
  assert.equal(diagnosis, null);
  const effective = await getEffectiveSettings(baseSettings, COURSE_URL);
  assert.equal(effective.clickMode, 'vision');
});

test('backs off the capture interval after a 429', async () => {
  const diagnosis = await recordApiFailure(COURSE_URL, 429);
  assert.equal(diagnosis.action, 'backoff');

  const effective = await getEffectiveSettings(baseSettings, COURSE_URL);
  assert.equal(effective.intervalSeconds, 68);
});

test('allows one automatic quiz strategy retry per window', async () => {
  const first = await recordQuizRetryLimit(COURSE_URL);
  assert.equal(first.action, 'quiz-retry-mode');
  assert.equal(first.mode, 'vision');

  const second = await recordQuizRetryLimit(COURSE_URL);
  assert.equal(second, null);
});

test('self-heal disabled leaves settings untouched', async () => {
  await recordActionResults(COURSE_URL, [{ type: 'click_at', ok: false }]);
  await recordActionResults(COURSE_URL, [{ type: 'click_at', ok: false }]);
  const effective = await getEffectiveSettings({ ...baseSettings, selfHeal: false }, COURSE_URL);
  assert.equal(effective.clickMode, 'hybrid');
});
