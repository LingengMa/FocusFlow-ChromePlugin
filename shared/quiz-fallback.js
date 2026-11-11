/**
 * Deterministic answer fallback. When the model cannot decide, or repeats an
 * already-tried option, the extension selects the next untried choice from the
 * page structure. The goal is unattended coverage of every option.
 */

export function normalizeChoiceLabel(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[.。、，,：:；;（）()[\]]/g, '')
    .toLowerCase();
}

export function quizSignature(snapshot) {
  const quiz = snapshot?.quiz;
  if (!quiz?.detected) return '';
  const labels = (quiz.choices || []).map((choice) => choice.label || '').join('|');
  return `${quiz.question || ''}::${labels}`;
}

function choiceEntry(snapshot, choice) {
  if (!choice?.elementId || !snapshot?.elementIndex) return null;
  return snapshot.elementIndex.get(choice.elementId) || null;
}

export function selectedQuizLabels(plan, snapshot) {
  const choices = snapshot?.quiz?.choices || [];
  const labels = [];
  for (const action of plan?.actions || []) {
    if (action.type === 'choose' || action.type === 'click') {
      const entry = action.localId && snapshot?.elementIndex
        ? [...snapshot.elementIndex.values()].find((item) => item.localId === action.localId)
        : choiceEntry(snapshot, choices.find((choice) => choice.elementId === action.elementId));
      if (entry?.group === 'quiz' && entry.label) labels.push(entry.label);
      continue;
    }
    if (action.type === 'click_at') {
      const normalized = normalizeChoiceLabel(action.target);
      const match = choices.find((choice) => {
        const label = normalizeChoiceLabel(choice.label);
        return label && (normalized.includes(label) || label.includes(normalized));
      });
      if (match?.label) labels.push(match.label);
    }
  }
  return labels;
}

export function buildQuizFallback({ snapshot, runtime }) {
  if (!snapshot?.quiz?.detected) return null;
  const choices = (snapshot.quiz.choices || []).filter((choice) => choice.elementId);
  if (choices.length === 0) return null;

  const signature = quizSignature(snapshot);
  const sameQuiz = runtime?.quizSignature === signature;
  const attempted = sameQuiz && Array.isArray(runtime?.quizAttemptedOptions)
    ? runtime.quizAttemptedOptions
    : [];
  let round = sameQuiz ? Number(runtime?.quizOptionRound) || 0 : 0;
  const attemptedSet = new Set(attempted.map(normalizeChoiceLabel));
  let next = choices.find((choice) => !attemptedSet.has(normalizeChoiceLabel(choice.label)));

  if (!next) {
    if (round >= 2) {
      return { exhausted: true, reason: '所有选项已循环两轮，仍未通过。' };
    }
    round += 1;
    next = choices[0];
    attemptedSet.clear();
  }

  const entry = choiceEntry(snapshot, next);
  if (!entry) return null;

  const actions = [{
    type: 'choose',
    elementId: next.elementId,
    frameId: entry.frameId,
    localId: entry.localId,
    elementLabel: next.label || ''
  }];

  const submit = (snapshot.quiz.submitCandidates || []).find((item) => item.elementId);
  if (submit) {
    const submitEntry = snapshot.elementIndex?.get(submit.elementId);
    actions.push({
      type: 'submit',
      elementId: submit.elementId,
      frameId: submitEntry?.frameId ?? snapshot.quiz.frameId ?? 0,
      localId: submitEntry?.localId || ''
    });
  } else {
    actions.push({
      type: 'submit',
      frameId: snapshot.quiz.frameId ?? 0,
      localId: ''
    });
  }

  return {
    actions,
    signature,
    attempted: [...attempted, next.label],
    round,
    selectedLabel: next.label,
    reason: `自动尝试选项：${next.label || next.elementId}`
  };
}
