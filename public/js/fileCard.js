/**
 * Shared file-card component.
 *
 * Every page that lists files (my files, files for me, favourites, search
 * results, the dashboard) used to carry its own copy of the same card
 * markup - five near-identical template literals that had already drifted
 * apart. They are now built here, so a change to a card is one change.
 *
 * THE CARD IS TWO-SIDED. The front is the identity of the file: category +
 * title. The back is the information about it: who uploaded it, the
 * description, and the actions. One click swaps between them. Before this,
 * the category was printed twice on the same card - once behind the flip
 * cover and again as the heading of the info block - and the description was
 * squeezed in underneath, so the two halves competed for the same space.
 */
(function () {
  'use strict';

  /** Translate at render time; falls back to English if i18n.js is absent. */
  function t(key, fallback) {
    return (typeof window.t === 'function' ? window.t(key, fallback) : fallback);
  }

  function esc(value) {
    const div = document.createElement('div');
    div.textContent = value === null || value === undefined ? '' : String(value);
    return div.innerHTML;
  }
  // search.js also defines escapeHtml; whichever loads first wins and both
  // behave identically.
  if (typeof window.escapeHtml !== 'function') window.escapeHtml = esc;

  /**
   * The AI sparkle. Drawn inline so it cannot go missing, sized in `em` so it
   * follows the button's font-size, and `currentColor` so it inherits every
   * hover and theme change for free.
   */
  const AI_SPARKLE_SVG =
    '<svg class="card-ai-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M9 2Q9 9 16 9Q9 9 9 16Q9 9 2 9Q9 9 9 2Z"/>' +
    '<path fill="currentColor" opacity="0.75" d="M18.5 1.5Q18.5 5 22 5Q18.5 5 18.5 8.5Q18.5 5 15 5Q18.5 5 18.5 1.5Z"/>' +
    '<path fill="currentColor" opacity="0.55" d="M18 13.5Q18 17 21.5 17Q18 17 18 20.5Q18 17 14.5 17Q18 17 18 13.5Z"/>' +
    '</svg>';

  /** Flip one card (or the card containing the given element). */
  function flipFileCard(target) {
    const card = target instanceof Element ? target.closest('.flip-card') : null;
    if (card) card.classList.toggle('is-flipped');
  }

  function openFile(fileId) {
    window.location.href = `/views/Display.html?id=${encodeURIComponent(fileId)}`;
  }

  /**
   * Build one card element.
   *
   * @param {Object} file  - {id, title, description, category, username|uploader, favoritId}
   * @param {Object} [options]
   * @param {boolean} [options.favorite]   - show "add to favourites"
   * @param {boolean} [options.edit]       - show the edit (pencil) button
   * @param {boolean} [options.unfavorite] - show "remove from favourites"
   * @param {boolean} [options.summarize]  - show the AI "Sum" button
   * @returns {HTMLElement}
   */
  function buildFileCard(file, options) {
    const opts = options || {};
    const uploader = file.username || file.uploader || 'Unknown';
    const description = file.description || t('common.noDescription', 'No description was added for this file.');

    const card = document.createElement('div');
    card.className = 'card flip-card';
    card.dataset.fileId = String(file.id);
    if (file.favoritId !== undefined && file.favoritId !== null) {
      card.dataset.favoriteId = String(file.favoritId);
      // deleteFavorite() in displayChat.js removes the card by this attribute.
      card.setAttribute('data-favorite-id', String(file.favoritId));
    }

    // Search can now return a file that shares no words with the query at all,
    // because the embedding said it is about the same thing. Without a label
    // that result looks like a bug, so it says why it is here.
    const relatedChip = file._semantic
      ? `<span class="card-related-chip" title="${esc(t('search.byMeaningHint', 'Found because it is about the same topic, not because it matched your words'))}">` +
        `${AI_SPARKLE_SVG.replace('card-ai-icon', 'card-chip-icon')}${esc(t('search.byMeaning', 'Related'))}</span>`
      : '';

    const editLabel = esc(t('files.edit', 'Edit this file'));
    const unfavLabel = esc(t('files.removeFavorite', 'Remove from favourites'));
    const favLabel = esc(t('files.addFavorite', 'Add to favourites'));

    const cornerButton = opts.edit
      ? `<button type="button" class="flip-card-corner" data-action="edit" title="${editLabel}" aria-label="${editLabel}"><i class="fa-regular fa-pen-to-square"></i></button>`
      : opts.unfavorite
        ? `<button type="button" class="flip-card-corner" data-action="unfavorite" title="${unfavLabel}" aria-label="${unfavLabel}"><i class="fa fa-bookmark"></i></button>`
        : '';

    const aiLabel = esc(t('files.aiSummary', 'AI Summary'));

    const actions = [
      `<button type="button" data-action="open">${esc(t('common.open', 'Open'))}</button>`,
      `<button type="button" data-action="message">${esc(t('common.chat', 'Chat'))}</button>`,
      // The favourite button is icon-only and now says so out loud: it carries
      // its own class so the stylesheet can give it a bookmark-specific hover
      // (it fills in, lifts, and the icon nudges up) instead of the same flat
      // grey wash every other action button gets.
      opts.favorite
        ? `<button type="button" class="card-action-icon card-fav-btn" data-action="favorite" aria-pressed="false" title="${favLabel}" aria-label="${favLabel}"><i class="fa fa-bookmark" aria-hidden="true"></i></button>`
        : '',
      // "Sum" was a word that meant nothing at a glance and read as
      // "summation" as often as "summary". It is the standard AI sparkle now.
      // The glyph is an inline SVG rather than a Font Awesome class because
      // the sparkle icons moved names between Font Awesome 5 and 6, and a
      // missing icon here would leave a blank button with no label at all.
      opts.summarize
        ? `<button type="button" class="card-action-icon card-ai-btn" data-action="summarize" title="${aiLabel}" aria-label="${aiLabel}">${AI_SPARKLE_SVG}<span class="card-action-text">${aiLabel}</span></button>`
        : ''
    ].filter(Boolean).join('');

    card.innerHTML = `
      <div class="flip-card-inner">
        <div class="flip-card-face flip-card-front">
          ${cornerButton}
          <div class="card-flip-tags">
            <span class="card-flip-category"><i class="fa fa-book-open card-flip-icon"></i>${esc(file.category)}</span>
            ${relatedChip}
          </div>
          <h3 class="flip-card-title">${esc(file.title)}</h3>
          <p class="flip-card-uploader">${esc(uploader)}</p>
          <button type="button" class="flip-card-toggle" data-action="flip">
            ${esc(t('common.details', 'Details'))} <i class="fa fa-arrow-right-arrow-left" aria-hidden="true"></i>
          </button>
        </div>

        <div class="flip-card-face flip-card-back">
          <div class="flip-card-back-body">
            <p class="uploadby"><strong>${esc(t('common.uploadedBy', 'Uploaded by:'))}</strong> ${esc(uploader)}</p>
            <div class="card-description-overlay">${esc(description)}</div>
          </div>
          <div class="actions">${actions}</div>
          <button type="button" class="flip-card-toggle" data-action="flip">
            <i class="fa fa-arrow-left" aria-hidden="true"></i> ${esc(t('common.back', 'Back'))}
          </button>
        </div>
      </div>
    `;

    // One delegated listener per card instead of inline onclick="" attributes.
    // The description and title are user-supplied; keeping them out of
    // attribute values removes a whole class of injection worry, and it means
    // summarizeFile() receives the real string rather than a re-parsed one.
    card.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-action]');
      if (!trigger || !card.contains(trigger)) return;

      switch (trigger.dataset.action) {
        case 'flip':
          flipFileCard(card);
          break;
        case 'open':
          openFile(file.id);
          break;
        case 'message':
          if (typeof window.openMsg === 'function') window.openMsg(file.id, uploader);
          break;
        case 'favorite':
          // A toggle, not an add. It used to call addToFavorites() every time,
          // so a second press asked the server to add a file that was already
          // there, got "already in your favourites" back, and changed nothing
          // on screen - indistinguishable from a dead button.
          trigger.classList.remove('is-pressed');
          void trigger.offsetWidth; // restart the animation on a repeat click
          trigger.classList.add('is-pressed');
          if (typeof window.toggleFavorite === 'function') window.toggleFavorite(file.id, trigger);
          else if (typeof window.addToFavorites === 'function') window.addToFavorites(file.id);
          break;
        case 'unfavorite':
          if (typeof window.confirmDeletion === 'function') window.confirmDeletion(file.favoritId);
          break;
        case 'edit':
          if (typeof window.modify === 'function') window.modify(file.id);
          break;
        case 'summarize':
          // Shared implementation in public/js/aiSummary.js. It summarises the
          // FILE (the server extracts its text); the description is only a
          // fallback for a file with no extractable content.
          if (typeof window.summarizeFile === 'function') {
            window.summarizeFile(file.id, description, event, file.title);
          }
          break;
        default:
          break;
      }
    });

    // Clicking the card body (not a control) flips it as well - the whole
    // card is the affordance, the "Details" button is just the visible hint.
    card.addEventListener('click', (event) => {
      if (event.target.closest('[data-action]')) return;
      flipFileCard(card);
    });

    // Keyboard: the card is focusable and Enter/Space flips it, so the back
    // side (and everything on it) is reachable without a mouse.
    card.tabIndex = 0;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', `${file.title} - ${file.category}`);
    card.addEventListener('keydown', (event) => {
      if (event.target !== card) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        flipFileCard(card);
      }
    });

    return card;
  }

  /**
   * Replace a container's contents with cards for `files`.
   * @param {Element|string} container - element or CSS selector
   * @param {Array} files
   * @param {Object} [options] - passed through to buildFileCard, plus:
   * @param {string} [options.emptyKey]     - i18n key for the empty state
   * @param {string} [options.emptyMessage] - fallback text when there are no files
   * @param {string} [options.emptyIcon]    - Font Awesome class for the empty state
   */
  // What each container last rendered, so switching language can rebuild the
  // cards. Their text was produced by t() when they were created, so it does
  // not update on its own the way `data-i18n` markup does.
  const lastRender = new WeakMap();

  function renderFileCards(container, files, options) {
    const opts = options || {};
    const host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) return;

    lastRender.set(host, { files, opts });
    host.innerHTML = '';

    if (!Array.isArray(files) || files.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cards-empty-state';
      // emptyKey (not a literal string) so the message follows the language
      // when it is switched and the list is re-rendered.
      const message = opts.emptyKey
        ? t(opts.emptyKey, opts.emptyMessage || 'Nothing to show here yet.')
        : (opts.emptyMessage || 'Nothing to show here yet.');
      empty.innerHTML =
        `<i class="${esc(opts.emptyIcon || 'fa fa-folder-open')}"></i>` +
        `<span>${esc(message)}</span>`;
      host.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    files.forEach((file) => fragment.appendChild(buildFileCard(file, opts)));
    host.appendChild(fragment);

    if (opts.favorite) syncFavoriteButtons(host);
  }

  /**
   * Fill in the bookmarks that are already favourites.
   *
   * Cards are drawn from the file list, which says nothing about who has
   * favourited what, so every bookmark starts out empty. Left that way the
   * first press on an already-favourited file reads as "add" and appears to do
   * nothing. One request per render (shared and cached in displayChat.js)
   * settles the whole page.
   */
  function syncFavoriteButtons(host) {
    if (typeof window.getFavoriteIds !== 'function') return;
    window.getFavoriteIds().then((ids) => {
      host.querySelectorAll('[data-action="favorite"]').forEach((button) => {
        const card = button.closest('[data-file-id]');
        if (!card) return;
        const isFavorite = ids.has(Number(card.dataset.fileId));
        if (typeof window.paintFavoriteButton === 'function') {
          window.paintFavoriteButton(button, isFavorite);
        }
      });
    }).catch(() => { /* the buttons still work, they just start empty */ });
  }

  window.addEventListener('sh:langchange', () => {
    document.querySelectorAll('.container, #searchResults, #file-container').forEach((host) => {
      const previous = lastRender.get(host);
      if (previous) renderFileCards(host, previous.files, previous.opts);
    });
  });

  window.buildFileCard = buildFileCard;
  window.renderFileCards = renderFileCards;
  window.flipFileCard = flipFileCard;
  window.openFile = openFile;
})();
