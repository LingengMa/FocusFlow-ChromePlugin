/**
 * Adaptive cadence after answering a quiz. Wrong/unknown answers get a short
 * verification interval; a correct answer or a disappeared quiz returns to the
 * normal capture interval.
 */

export const QUIZ_MAX_VERIFY = 6;

const PLAY_OR_NEXT_RE = /播放|下一|继续学习|关闭|取消/i;

export function isQuizAnswerAction(action, snapshot, decision) {
  if (!action) return false;
  if (['choose', 'type', 'submit', 'type_at'].includes(action.type)) return true;
  if (action.type === 'click' && action.group === 'quiz') return true;
  const quizContext = Boolean(
    snapshot?.quiz?.detected ||
    decision?.quiz?.detected ||
    decision?.state === 'quiz'
  );
  return action.type === 'click_at' &&
    quizContext &&
    !PLAY_OR_NEXT_RE.test(action.target || '');
}

function inferCorrect(decision) {
  if (decision?.quiz?.correct === true || decision?.quiz?.correct === false) {
    return decision.quiz.correct;
  }
  const feedback = String(decision?.quiz?.feedback || '');
  if (/错误|答错|不正确|未通过|再试|重新选择/.test(feedback)) return false;
  if (/正确|答对|通过/.test(feedback)) return true;
  return null;
}

export function nextQuizCadence({ snapshot, decision, plan, runtime, settings }) {
  const quizVisible = Boolean(
    snapshot?.quiz?.detected ||
    decision?.quiz?.detected ||
    decision?.state === 'quiz'
  );
  const answered = Boolean(
    plan?.actions?.some((action) => isQuizAnswerAction(action, snapshot, decision))
  );
  const armed = Boolean(runtime?.quizVerifyArmed);
  const count = Number(runtime?.quizRetryCount) || 0;
  const correct = inferCorrect(decision);

  if (settings?.dryRun) {
    return { mode: 'normal', armed: false, count: 0, answered, reason: 'dry-run' };
  }

  if (answered && quizVisible) {
    return {
      mode: 'verify',
      armed: true,
      count: count + 1,
      answered,
      reason: 'answered'
    };
  }

  if (armed) {
    if (!quizVisible || correct === true) {
      return { mode: 'normal', armed: false, count: 0, answered, reason: 'correct_or_gone' };
    }

    const nextCount = count + 1;
    const optionCount = Array.isArray(snapshot?.quiz?.choices) ? snapshot.quiz.choices.length : 0;
    const maxVerify = Math.max(QUIZ_MAX_VERIFY, optionCount * 2 + 4);
    if (nextCount > maxVerify) {
      return {
        mode: 'stop',
        armed: false,
        count: 0,
        answered,
        reason: '所有选项已循环尝试仍未通过，已停止自动提交。请手动检查。'
      };
    }

    return {
      mode: 'verify',
      armed: true,
      count: nextCount,
      answered,
      reason: correct === false ? 'wrong_feedback' : 'waiting_feedback'
    };
  }

  return { mode: 'normal', armed: false, count: 0, answered, reason: 'not_quiz' };
}
