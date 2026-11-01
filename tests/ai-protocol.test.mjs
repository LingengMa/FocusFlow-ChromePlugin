import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProtocolError,
  normalizeDecision,
  parseConfidence,
  parseModelResponse
} from '../shared/ai-protocol.js';

test('parses fenced JSON with surrounding prose', () => {
  const text = `这是分析结果：
\`\`\`json
{
  "observation": "视频暂停，出现题目",
  "state": "quiz",
  "confidence": 92,
  "reason": "屏幕中央有答题弹窗",
  "quiz": {"detected": true, "question": "1+1=?", "answerSummary": "2"},
  "actions": [
    {"type": "answer", "elementId": "f0:e2"},
    {"type": "submit_answer", "elementId": "f0:e3"}
  ]
}
\`\`\``;

  const decision = parseModelResponse(text, { maxActions: 4 });
  assert.equal(decision.state, 'quiz');
  assert.equal(decision.confidence, 0.92);
  assert.equal(decision.actions.length, 2);
  assert.equal(decision.actions[0].type, 'choose');
  assert.equal(decision.actions[1].type, 'submit');
  assert.equal(decision.quiz.question, '1+1=?');
});

test('accepts a singular action field and percent confidence', () => {
  const decision = normalizeDecision({
    state: 'paused',
    confidence: '85%',
    action: { type: 'resume_video' }
  });
  assert.equal(decision.actions.length, 1);
  assert.equal(decision.actions[0].type, 'play');
  assert.equal(decision.confidence, 0.85);
});

test('drops unknown actions and unsupported element ids with warnings', () => {
  const decision = normalizeDecision({
    state: 'quiz',
    confidence: 0.9,
    actions: [
      { type: 'run_javascript', code: 'alert(1)' },
      { type: 'choose', elementId: 'document.querySelector("input")' },
      { type: 'submit', elementId: 'f2:e10' }
    ]
  });
  assert.equal(decision.actions.length, 1);
  assert.equal(decision.actions[0].type, 'submit');
  assert.equal(decision.warnings.length, 2);
});

test('truncates actions to the configured maximum', () => {
  const decision = normalizeDecision({
    state: 'quiz',
    confidence: 0.9,
    actions: Array.from({ length: 8 }, () => ({ type: 'choose', elementId: 'f0:e1' }))
  }, { maxActions: 3 });
  assert.equal(decision.actions.length, 3);
  assert.match(decision.warnings.join(' '), /上限 3/);
});

test('clamps seek and wait values', () => {
  const decision = normalizeDecision({
    state: 'playing',
    confidence: 0.8,
    actions: [
      { type: 'seek', seconds: -10 },
      { type: 'wait', seconds: 900 }
    ]
  });
  assert.equal(decision.actions[0].seconds, 0);
  assert.equal(decision.actions[1].seconds, 30);
});

test('normalizes visual click bboxes to center coordinates', () => {
  const decision = normalizeDecision({
    state: 'paused',
    confidence: 0.9,
    actions: [
      { type: 'click_at', bbox: [0.4, 0.5, 0.6, 0.7], target: '视频播放按钮' },
      { type: 'click_at', bbox: [40, 50, 60, 70], target: '下一节' }
    ]
  });
  assert.equal(decision.actions.length, 2);
  assert.deepEqual(decision.actions[0].bbox, [0.4, 0.5, 0.6, 0.7]);
  assert.equal(decision.actions[0].x, 0.5);
  assert.equal(decision.actions[0].y, 0.6);
  assert.equal(decision.actions[1].x, 0.5);
  assert.equal(decision.actions[1].y, 0.6);
  assert.equal(decision.actions[1].target, '下一节');
});

test('normalizes point and type_at actions', () => {
  const decision = normalizeDecision({
    state: 'quiz',
    confidence: 0.9,
    actions: [
      { type: 'click_at', point: [0.25, 0.75], target: 'B. 2' },
      { type: 'type_at', bbox: [0.2, 0.4, 0.8, 0.45], target: '答案输入框', text: '42' }
    ]
  });
  assert.equal(decision.actions[0].x, 0.25);
  assert.equal(decision.actions[0].y, 0.75);
  assert.ok(Math.abs((decision.actions[0].bbox[2] - decision.actions[0].bbox[0]) - 0.008) < 1e-9);
  assert.equal(decision.actions[1].type, 'type_at');
  assert.equal(decision.actions[1].text, '42');
});

test('normalizes coordinate scroll actions', () => {
  const decision = normalizeDecision({
    state: 'ended',
    confidence: 0.9,
    actions: [
      {
        type: 'scroll_at',
        bbox: [0.82, 0.35, 0.98, 0.75],
        target: '右侧目录',
        deltaY: 620
      }
    ]
  });
  assert.equal(decision.actions.length, 1);
  assert.equal(decision.actions[0].type, 'scroll_at');
  assert.equal(decision.actions[0].deltaY, 620);
  assert.equal(decision.actions[0].x, 0.9);
});

test('normalizes quiz correctness and feedback', () => {
  const wrong = normalizeDecision({
    state: 'quiz',
    confidence: 0.9,
    quiz: { detected: true, correct: 'false', feedback: '回答错误，请重试' },
    actions: []
  });
  assert.equal(wrong.quiz.correct, false);
  assert.equal(wrong.quiz.feedback, '回答错误，请重试');

  const correct = normalizeDecision({
    state: 'quiz',
    confidence: 0.9,
    quiz: { detected: true, correct: 'correct' },
    actions: []
  });
  assert.equal(correct.quiz.correct, true);

  const unknown = normalizeDecision({
    state: 'quiz',
    confidence: 0.9,
    quiz: { detected: true },
    actions: []
  });
  assert.equal(unknown.quiz.correct, null);
});

test('normalizes course completion flags', () => {
  const complete = normalizeDecision({
    state: 'ended',
    courseComplete: true,
    confidence: 0.9,
    actions: []
  });
  assert.equal(complete.courseComplete, true);

  const stringFlag = normalizeDecision({
    state: 'ended',
    courseComplete: 'true',
    confidence: 0.9,
    actions: []
  });
  assert.equal(stringFlag.courseComplete, true);

  const notComplete = normalizeDecision({
    state: 'playing',
    confidence: 0.9,
    actions: []
  });
  assert.equal(notComplete.courseComplete, false);
});

test('drops click_at without a target description', () => {
  const decision = normalizeDecision({
    state: 'playing',
    confidence: 0.9,
    actions: [{ type: 'click_at', bbox: [0.1, 0.1, 0.2, 0.2] }]
  });
  assert.equal(decision.actions.length, 0);
  assert.match(decision.warnings.join(' '), /target/);
});

test('rejects non-JSON and empty output', () => {
  assert.throws(() => parseModelResponse('我不知道该怎么做。'), ProtocolError);
  assert.throws(() => parseModelResponse(''), ProtocolError);
});

test('parseConfidence handles numbers and percentages', () => {
  assert.equal(parseConfidence(0.4567), 0.457);
  assert.equal(parseConfidence('72%'), 0.72);
  assert.equal(parseConfidence(undefined), 0);
});
