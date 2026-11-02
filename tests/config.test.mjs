import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  isHostAllowed,
  normalizeBaseUrl,
  normalizeHostPatterns,
  normalizeSettings
} from '../shared/defaults.js';

test('normalizeSettings clamps unsafe values and fills defaults', () => {
  const settings = normalizeSettings({
    intervalSeconds: 1,
    maxImageWidth: 100,
    jpegQuality: 200,
    confidenceThreshold: 2,
    maxActions: 99,
    maxRuntimeMinutes: 0,
    allowedHosts: ['Example.com', 'https://*.school.edu.cn/path', 'bad host', 'example.com']
  });

  assert.equal(settings.intervalSeconds, 30);
  assert.equal(settings.maxImageWidth, 640);
  assert.equal(settings.jpegQuality, 95);
  assert.equal(settings.confidenceThreshold, 0.99);
  assert.equal(settings.maxActions, 8);
  assert.equal(settings.maxRuntimeMinutes, 5);
  assert.deepEqual(settings.allowedHosts, ['example.com', '*.school.edu.cn']);
  assert.equal(settings.model, DEFAULT_SETTINGS.model);
});

test('normalizeBaseUrl accepts bare hosts and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1///'), 'https://api.deepseek.com/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3000/v1/'), 'http://127.0.0.1:3000/v1');
});

test('host allow-list matching does not allow suffix spoofing', () => {
  const patterns = normalizeHostPatterns('*.example.com\nexample.org');
  assert.equal(isHostAllowed('https://sub.example.com/course', patterns), true);
  assert.equal(isHostAllowed('https://example.com/course', patterns), true);
  assert.equal(isHostAllowed('https://example.com.evil.net/course', patterns), false);
  assert.equal(isHostAllowed('https://example.org/course', patterns), true);
  assert.equal(isHostAllowed('https://other.org/course', patterns), false);
  assert.equal(isHostAllowed('https://anything.test/course', []), true);
});

test('normalizeSettings converts string booleans safely', () => {
  const settings = normalizeSettings({
    autoResume: 'false',
    autoAnswer: 'true',
    autoSubmit: '0',
    autoNext: 'on'
  });
  assert.equal(settings.autoResume, false);
  assert.equal(settings.autoAnswer, true);
  assert.equal(settings.autoSubmit, false);
  assert.equal(settings.autoNext, true);
});

test('normalizeSettings validates click mode and migrates legacy vision-only', () => {
  assert.equal(normalizeSettings({ clickMode: 'vision', settingsVersion: 2 }).clickMode, 'vision');
  assert.equal(normalizeSettings({ clickMode: 'dom', settingsVersion: 2 }).clickMode, 'dom');
  assert.equal(normalizeSettings({ clickMode: 'vision' }).clickMode, 'hybrid');
  assert.equal(normalizeSettings({ clickMode: 'nonsense' }).clickMode, 'hybrid');
});
