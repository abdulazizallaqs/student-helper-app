// AI study tools (quiz + flashcards) for the file viewer page (Display.html).
(function () {
  /** i18n with a fallback, for the panel's own wording (not the AI's answers). */
  function tr(key, fallback) {
    return typeof window.t === 'function' ? window.t(key, fallback) : fallback;
  }

  /**
   * Lay the answers out in the direction the ANSWERS are written in.
   *
   * The panel was fixed at `direction: rtl` with its quiz options
   * right-aligned. That is correct for Arabic notes and wrong for English
   * ones - and it stayed wrong even after the model started replying in the
   * document's own language, because the direction was decided by the
   * stylesheet rather than by the text.
   *
   * Note this is NOT the interface language: a student reading the site in
   * Arabic can open an English PDF, and its quiz belongs left-to-right.
   */
  function applyContentDirection(element, text) {
    const sample = String(text || '').slice(0, 600);
    const arabic = (sample.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
    const latin = (sample.match(/[A-Za-z]/g) || []).length;
    const rtl = arabic > latin;
    element.dir = rtl ? 'rtl' : 'ltr';
    element.style.textAlign = 'start';
  }

  function getFileId() {
    return new URLSearchParams(window.location.search).get('id');
  }

  function openAiModal(title) {
    const panel = document.querySelector('.ai-result-content');
    // Until there is content, follow the interface language.
    if (panel) panel.dir = document.documentElement.dir || 'ltr';
    document.getElementById('aiResultTitle').textContent = title;
    document.getElementById('aiResultBody').innerHTML =
      '<p class="ai-loading"></p>';
    document.querySelector('#aiResultBody .ai-loading').textContent =
      tr('aiTools.generating', 'Generating with AI...');
    document.getElementById('aiResultModal').style.display = 'block';
  }

  function closeAiModal() {
    document.getElementById('aiResultModal').style.display = 'none';
  }
  window.closeAiModal = closeAiModal;

  function showError(message, detail) {
    const body = document.getElementById('aiResultBody');
    body.innerHTML = '<p class="ai-error"></p>';
    // Server error text rendered as plain text, not HTML - today's values are
    // our own fixed strings, but nothing here should rely on that never
    // changing, and `detail` carries text straight from Google.
    body.querySelector('.ai-error').textContent = message;

    if (detail) {
      const details = document.createElement('details');
      details.className = 'msg-error-detail';
      const summary = document.createElement('summary');
      summary.textContent = tr('aiTools.technicalDetails', 'Technical details');
      const pre = document.createElement('pre');
      pre.textContent = detail;
      details.appendChild(summary);
      details.appendChild(pre);
      body.appendChild(details);
    }
  }

  function renderQuiz(quiz) {
    const body = document.getElementById('aiResultBody');
    body.innerHTML = '';

    if (!Array.isArray(quiz) || quiz.length === 0) {
      showError(tr('aiTools.noQuiz', 'A quiz could not be generated from this file.'));
      return;
    }

    // The direction comes from the questions themselves, not from the site's
    // language setting - see applyContentDirection.
    const panel = document.querySelector('.ai-result-content');
    if (panel) applyContentDirection(panel, quiz.map((q) => q.question).join(' '));

    quiz.forEach((q, qi) => {
      const wrap = document.createElement('div');
      wrap.className = 'ai-quiz-question';

      const questionEl = document.createElement('p');
      questionEl.className = 'ai-quiz-question-text';
      questionEl.textContent = `${qi + 1}. ${q.question}`;
      wrap.appendChild(questionEl);

      (q.options || []).forEach((opt, oi) => {
        const optBtn = document.createElement('button');
        optBtn.type = 'button';
        optBtn.className = 'ai-quiz-option';
        optBtn.textContent = opt;
        optBtn.addEventListener('click', () => {
          const correct = oi === q.correctIndex;
          optBtn.classList.add(correct ? 'correct' : 'incorrect');
          if (!correct) {
            const options = wrap.querySelectorAll('.ai-quiz-option');
            const correctBtn = options[q.correctIndex];
            if (correctBtn) correctBtn.classList.add('correct');
          }
          wrap.querySelectorAll('.ai-quiz-option').forEach(b => { b.disabled = true; });
        });
        wrap.appendChild(optBtn);
      });

      body.appendChild(wrap);
    });
  }

  function renderFlashcards(cards) {
    const body = document.getElementById('aiResultBody');
    body.innerHTML = '';

    if (!Array.isArray(cards) || cards.length === 0) {
      showError(tr('aiTools.noCards', 'Revision cards could not be generated from this file.'));
      return;
    }

    const panel = document.querySelector('.ai-result-content');
    if (panel) applyContentDirection(panel, cards.map((c) => `${c.front} ${c.back}`).join(' '));

    const hint = document.createElement('p');
    hint.className = 'ai-hint';
    hint.textContent = tr('aiTools.flipHint', 'Tap any card to see the answer');
    body.appendChild(hint);

    cards.forEach(card => {
      const el = document.createElement('div');
      el.className = 'ai-flashcard';
      el.innerHTML = `<div class="ai-flashcard-front"></div><div class="ai-flashcard-back"></div>`;
      el.querySelector('.ai-flashcard-front').textContent = card.front || '';
      el.querySelector('.ai-flashcard-back').textContent = card.back || '';
      el.addEventListener('click', () => el.classList.toggle('flipped'));
      body.appendChild(el);
    });
  }

  async function requestAiTool(kind) {
    const fileId = getFileId();
    if (!fileId) return;

    openAiModal(kind === 'quiz'
      ? tr('aiTools.quizTitle', 'Quick quiz')
      : tr('aiTools.flashcardsTitle', 'Revision cards'));

    try {
      const response = await fetch(`/api/ai/${kind}/${fileId}`, { method: 'POST' });
      const data = await response.json();

      if (!response.ok) {
        // `message` is the actionable sentence the API now returns (bad key,
        // quota used up, retired model, no network). `error` is just a code,
        // and `detail` is the exact upstream text in development.
        showError(data.message || data.error || tr('aiTools.failed', 'Something went wrong while generating this.'), data.detail);
        return;
      }

      if (kind === 'quiz') {
        renderQuiz(data.quiz);
      } else {
        renderFlashcards(data.flashcards);
      }
    } catch (error) {
      console.error('AI tool error:', error);
      showError(tr('aiTools.offline', 'Could not reach the server.'));
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const quizBtn = document.getElementById('btnQuiz');
    const flashBtn = document.getElementById('btnFlashcards');
    if (quizBtn) quizBtn.addEventListener('click', () => requestAiTool('quiz'));
    if (flashBtn) flashBtn.addEventListener('click', () => requestAiTool('flashcards'));
  });
})();
