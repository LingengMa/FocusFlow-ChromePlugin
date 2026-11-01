import test from 'node:test';
import assert from 'node:assert/strict';

import { nextQuizCadence, QUIZ_MAX_VERIFY } from '../shared/quiz-followup.js';

function snapshot(quiz = true) {
  return {
    quiz: { detected: quiz }
  };
}

function decision(correct = null) {
  return { quiz: { detected: true, correct } };
}

test('answer on a visible quiz schedules a short verification cycle', () => {
  const cadence = nextQuizCadence({
    snapshot: snapshot(true),
    decision: decision(null),
    plan: { actions: [{ type: 'choose', elementId: 'f0:e1' }] },
    runtime: { quizVerifyArmed: false, quizRetryCount: 0 },
    settings: { dryRun: false }
  });
  assert.equal(cadence.mode, 'verify');
  assert.equal(cadence.armed, true);
  assert.equal(cadence.count, 1);
  assert.equal(cadence.answered, true);
});

test('a disappeared quiz returns to the normal interval', () => {
  const cadence = nextQuizCadence({
    snapshot: snapshot(false),
    decision: { quiz: { detected: false }, state: 'playing' },
    plan: { actions: [] },
    runtime: { quizVerifyArmed: true, quizRetryCount: 3 },
    settings: { dryRun: false }
  });
  assert.equal(cadence.mode, 'normal');
  assert.equal(cadence.armed, false);
  assert.equal(cadence.count, 0);
});

test('correct feedback returns to the normal interval', () => {
  const cadence = nextQuizCadence({
    snapshot: snapshot(true),
    decision: decision(true),
    plan: { actions: [] },
    runtime: { quizVerifyArmed: true, quizRetryCount: 2 },
    settings: { dryRun: false }
  });
  assert.equal(cadence.mode, 'normal');
  assert.equal(cadence.count, 0);
});

test('wrong feedback keeps the short verification interval', () => {
  const cadence = nextQuizCadence({
    snapshot: snapshot(true),
    decision: decision(false),
    plan: { actions: [] },
    runtime: { quizVerifyArmed: true, quizRetryCount: 2 },
    settings: { dryRun: false }
  });
  assert.equal(cadence.mode, 'verify');
  assert.equal(cadence.count, 3);
  assert.equal(cadence.reason, 'wrong_feedback');
});

test('infers correctness from feedback text when boolean is absent', () => {
  const correct = nextQuizCadence({
    snapshot: snapshot(true),
    decision: { quiz: { detected: true, correct: null, feedback: '回答正确，已通过' } },
    plan: { actions: [] },
    runtime: { quizVerifyArmed: true, quizRetryCount: 1 },
    settings: { dryRun: false }
  });
  assert.equal(correct.mode, 'normal');

  const wrong = nextQuizCadence({
    snapshot: snapshot(true),
    decision: { quiz: { detected: true, correct: null, feedback: '回答错误，请再试一次' } },
    plan: { actions: [] },
    runtime: { quizVerifyArmed: true, quizRetryCount: 1 },
    settings: { dryRun: false }
  });
  assert.equal(wrong.mode, 'verify');
  assert.equal(wrong.reason, 'wrong_feedback');
});

test('too many failed verifications stop for manual handling', () => {
  const cadence = nextQuizCadence({
    snapshot: snapshot(true),
    decision: decision(false),
    plan: { actions: [] },
    runtime: { quizVerifyArmed: true, quizRetryCount: QUIZ_MAX_VERIFY },
    settings: { dryRun: false }
  });
  assert.equal(cadence.mode, 'stop');
});

test('simulated answers do not schedule verification', () => {
  const cadence = nextQuizCadence({
    snapshot: snapshot(true),
    decision: decision(null),
    plan: { actions: [{ type: 'choose', elementId: 'f0:e1' }] },
    runtime: { quizVerifyArmed: false, quizRetryCount: 0 },
    settings: { dryRun: true }
  });
  assert.equal(cadence.mode, 'normal');
});

test('visual click on a quiz option counts as answering', () => {
  const cadence = nextQuizCadence({
    snapshot: snapshot(true),
    decision: decision(null),
    plan: { actions: [{ type: 'click_at', target: 'B. 2' }] },
    runtime: { quizVerifyArmed: false, quizRetryCount: 0 },
    settings: { dryRun: false }
  });
  assert.equal(cadence.mode, 'verify');
});

test('visual click on play while a quiz is visible is not an answer', () => {
  const cadence = nextQuizCadence({
    snapshot: snapshot(true),
    decision: decision(null),
    plan: { actions: [{ type: 'click_at', target: '播放按钮' }] },
    runtime: { quizVerifyArmed: false, quizRetryCount: 0 },
    settings: { dryRun: false }
  });
  assert.equal(cadence.mode, 'normal');
});
