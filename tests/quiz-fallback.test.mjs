import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQuizFallback,
  normalizeChoiceLabel,
  quizSignature,
  selectedQuizLabels
} from '../shared/quiz-fallback.js';

function snapshot() {
  const elementIndex = new Map([
    ['f0:e1', { elementId: 'f0:e1', frameId: 0, localId: 'e1', group: 'quiz', label: 'A. 1' }],
    ['f0:e2', { elementId: 'f0:e2', frameId: 0, localId: 'e2', group: 'quiz', label: 'B. 2' }],
    ['f0:e3', { elementId: 'f0:e3', frameId: 0, localId: 'e3', group: 'quiz', label: 'C. 3' }],
    ['f0:e4', { elementId: 'f0:e4', frameId: 0, localId: 'e4', group: 'quiz', label: '提交答案' }]
  ]);
  return {
    quiz: {
      detected: true,
      frameId: 0,
      question: '1+1=?',
      choices: [
        { elementId: 'f0:e1', label: 'A. 1' },
        { elementId: 'f0:e2', label: 'B. 2' },
        { elementId: 'f0:e3', label: 'C. 3' }
      ],
      submitCandidates: [{ elementId: 'f0:e4', label: '提交答案' }]
    },
    elementIndex
  };
}

test('falls back to the first untried option and submits it', () => {
  const sp = snapshot();
  const fallback = buildQuizFallback({
    snapshot: sp,
    runtime: {
      quizSignature: quizSignature(sp),
      quizAttemptedOptions: ['A. 1'],
      quizOptionRound: 0
    }
  });
  assert.equal(fallback.actions[0].type, 'choose');
  assert.equal(fallback.actions[0].localId, 'e2');
  assert.equal(fallback.actions[1].type, 'submit');
  assert.deepEqual(fallback.attempted, ['A. 1', 'B. 2']);
});

test('cycles after every option was tried', () => {
  const sp = snapshot();
  const fallback = buildQuizFallback({
    snapshot: sp,
    runtime: {
      quizSignature: quizSignature(sp),
      quizAttemptedOptions: ['A. 1', 'B. 2', 'C. 3'],
      quizOptionRound: 0
    }
  });
  assert.equal(fallback.round, 1);
  assert.equal(fallback.actions[0].localId, 'e1');
});

test('stops after two full retry rounds', () => {
  const sp = snapshot();
  const fallback = buildQuizFallback({
    snapshot: sp,
    runtime: {
      quizSignature: quizSignature(sp),
      quizAttemptedOptions: ['A. 1', 'B. 2', 'C. 3'],
      quizOptionRound: 2
    }
  });
  assert.equal(fallback.exhausted, true);
});

test('recognizes selected labels from DOM and visual actions', () => {
  const sp = snapshot();
  const labels = selectedQuizLabels({
    actions: [
      { type: 'choose', localId: 'e2' },
      { type: 'click_at', target: 'A. 1' }
    ]
  }, sp);
  assert.deepEqual(labels, ['B. 2', 'A. 1']);
  assert.equal(normalizeChoiceLabel(' B. 2 '), 'b2');
});
