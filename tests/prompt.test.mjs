import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, normalizeSettings } from '../shared/defaults.js';
import { buildSystemPrompt, buildUserPrompt } from '../background/prompt.js';

const settings = normalizeSettings(DEFAULT_SETTINGS);

test('system prompt states the untrusted-content boundary and JSON-only output', () => {
  const prompt = buildSystemPrompt(settings);
  assert.match(prompt, /不可信数据/);
  assert.match(prompt, /提示注入|忽略以上指令/);
  assert.match(prompt, /只输出.*JSON/);
  assert.match(prompt, /自动选择并提交答案/);
});

test('system prompt reflects disabled automation switches', () => {
  const prompt = buildSystemPrompt(normalizeSettings({
    ...DEFAULT_SETTINGS,
    autoAnswer: false,
    autoSubmit: false,
    autoNext: false,
    autoResume: false
  }));
  assert.match(prompt, /不要自动作答/);
  assert.match(prompt, /不要自动切换下一节/);
  assert.match(prompt, /不要自动恢复播放/);
});

test('user prompt includes video, quiz, element ids and untrusted page text', () => {
  const text = buildUserPrompt({
    settings,
    runtime: {
      startedAt: Date.now() - 60000,
      cycleCount: 2,
      history: [{ at: Date.now(), state: 'playing', actions: ['继续播放'], result: 'ok', videoTime: 12 }]
    },
    snapshot: {
      url: 'https://course.example.com/lesson/1',
      title: '第一课',
      video: {
        found: true,
        frameId: 0,
        currentTime: 12,
        duration: 600,
        paused: false,
        ended: false,
        buffering: false,
        readyState: 4,
        playbackRate: 1
      },
      quiz: {
        detected: true,
        frameId: 0,
        score: 0.8,
        question: '1+1=?',
        text: '1+1=? A.1 B.2',
        choices: [{ elementId: 'f0:e2', label: 'B. 2', checked: false }],
        submitCandidates: [{ elementId: 'f0:e3', label: '提交' }]
      },
      controls: [
        { elementId: 'f0:e2', tag: 'input', type: 'radio', label: 'B. 2', group: 'quiz' }
      ],
      frames: [{ frameId: 0, isTop: true, pageText: '页面正文' }]
    }
  });
  assert.match(text, /1\+1=\?/);
  assert.match(text, /f0:e2/);
  assert.match(text, /页面正文/);
  assert.match(text, /不可信数据/);
});
