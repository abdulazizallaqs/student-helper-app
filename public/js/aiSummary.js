/**
 * The AI-summary button on a file card: ask the AI for a summary and show it.
 *
 * This used to live inside file-page-forme.html, so the button only existed
 * on the "For Me" page - My Files, Favourites and search results had no way
 * to summarise anything. It is shared now, and every card list offers it.
 *
 * It also summarises the RIGHT thing. The old version sent the card's
 * description - usually one line the uploader typed - so the "summary" was a
 * paraphrase of a sentence. It now asks the server to summarise the file's
 * own contents (the server extracts the PDF text), and only falls back to the
 * description when the file has no extractable text.
 */
(function () {
  'use strict';

  const t = (key, fallback) =>
    (typeof window.t === 'function' ? window.t(key, fallback) : fallback);

  const esc = (value) => {
    const div = document.createElement('div');
    div.textContent = value === null || value === undefined ? '' : String(value);
    return div.innerHTML;
  };

  function notify(message, kind) {
    if (typeof window.showToast === 'function') window.showToast(message, kind);
    else alert(message);
  }

  function showSummary(title, summary) {
    const overlay = document.createElement('div');
    overlay.className = 'ai-summary-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    // The summary is AI output derived from a file any user can upload, so it
    // is untrusted: inserted as text, never as HTML.
    overlay.innerHTML = `
      <div class="ai-summary-panel">
        <button type="button" class="ai-summary-close" aria-label="${esc(t('common.back', 'Close'))}">&times;</button>
        <h2 class="ai-summary-title"></h2>
        <p class="ai-summary-file"></p>
        <div class="ai-summary-body"></div>
      </div>
    `;
    overlay.querySelector('.ai-summary-title').textContent = t('files.aiSummary', 'AI Summary');
    overlay.querySelector('.ai-summary-file').textContent = title || '';
    overlay.querySelector('.ai-summary-body').textContent = summary;

    const close = () => overlay.remove();
    overlay.querySelector('.ai-summary-close').addEventListener('click', close);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    document.addEventListener('keydown', function onKey(event) {
      if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });

    document.body.appendChild(overlay);
    overlay.querySelector('.ai-summary-close').focus();
  }

  /**
   * @param {number|string} fileId    - the file to summarise
   * @param {string} [description]    - fallback text when the file has none
   * @param {Event}  [evt]            - the click, so the button can show progress
   * @param {string} [title]          - file title, shown in the dialog
   */
  async function summarizeFile(fileId, description, evt, title) {
    const button = evt && evt.target ? evt.target.closest('button') : null;

    // The button is an ICON now, not the word "Sum". The old progress
    // indicator overwrote button.innerText with "Thinking..." and restored the
    // captured text afterwards - on an icon button that captured string is
    // empty, so the icon would have been wiped out and never come back. So
    // nothing is replaced: the content is hidden behind a spinner by CSS
    // (.btn-busy) and revealed again when the request settles. The accessible
    // name is swapped separately, because a screen reader cannot see a
    // spinner.
    const originalLabel = button ? button.getAttribute('aria-label') : null;
    if (button) {
      button.classList.add('btn-busy');
      button.setAttribute('aria-busy', 'true');
      button.setAttribute('aria-label', t('files.thinking', 'Thinking...'));
      button.disabled = true;
    }

    try {
      // Prefer the file's real contents; the server falls back to whatever
      // text we send if it cannot extract any.
      const response = await fetch(`/api/ai/summarize/${encodeURIComponent(fileId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fallbackText: description || '' })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        // The API reports the real reason now - a rejected key, an exhausted
        // quota, a retired model, a blocked network. `detail` is the exact
        // upstream text (development only) and is logged so it is findable
        // without opening the server's terminal.
        notify(data.message || t('files.noSummary', 'Could not generate a summary.'), 'error');
        if (data.detail) console.error('[ai] summary failed:', data.detail);
        if (response.status === 401) setTimeout(() => { window.location.href = '/login'; }, 1500);
        return;
      }

      if (data.summary) showSummary(title || data.title, data.summary);
      else notify(t('files.noSummary', 'Could not generate a summary.'), 'warning');
    } catch (error) {
      console.error('Summary request failed:', error);
      notify(t('chat.noServer', 'Could not reach the server. Check your connection.'), 'error');
    } finally {
      if (button) {
        button.classList.remove('btn-busy');
        button.removeAttribute('aria-busy');
        if (originalLabel === null) button.removeAttribute('aria-label');
        else button.setAttribute('aria-label', originalLabel);
        button.disabled = false;
      }
    }
  }

  window.summarizeFile = summarizeFile;
})();
