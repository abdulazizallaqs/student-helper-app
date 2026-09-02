// AI study tools (quiz + flashcards) for the file viewer page (Display.html).
(function () {
  function getFileId() {
    return new URLSearchParams(window.location.search).get('id');
  }

  function openAiModal(title) {
    document.getElementById('aiResultTitle').textContent = title;
    document.getElementById('aiResultBody').innerHTML = '<p class="ai-loading">جاري التوليد بالذكاء الاصطناعي...</p>';
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
      summary.textContent = 'التفاصيل التقنية';
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
      showError('تعذر توليد اختبار من هذا الملف.');
      return;
    }

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
      showError('تعذر توليد بطاقات مراجعة من هذا الملف.');
      return;
    }

    const hint = document.createElement('p');
    hint.className = 'ai-hint';
    hint.textContent = 'اضغط على أي بطاقة لعرض الإجابة';
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

    openAiModal(kind === 'quiz' ? 'اختبار سريع' : 'بطاقات المراجعة');

    try {
      const response = await fetch(`/api/ai/${kind}/${fileId}`, { method: 'POST' });
      const data = await response.json();

      if (!response.ok) {
        // `message` is the actionable sentence the API now returns (bad key,
        // quota used up, retired model, no network). `error` is just a code,
        // and `detail` is the exact upstream text in development.
        showError(data.message || data.error || 'حدث خطأ أثناء التوليد.', data.detail);
        return;
      }

      if (kind === 'quiz') {
        renderQuiz(data.quiz);
      } else {
        renderFlashcards(data.flashcards);
      }
    } catch (error) {
      console.error('AI tool error:', error);
      showError('تعذر الاتصال بالخادم.');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const quizBtn = document.getElementById('btnQuiz');
    const flashBtn = document.getElementById('btnFlashcards');
    if (quizBtn) quizBtn.addEventListener('click', () => requestAiTool('quiz'));
    if (flashBtn) flashBtn.addEventListener('click', () => requestAiTool('flashcards'));
  });
})();
