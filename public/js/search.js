/**
 * Shared search behaviour for every page that has a search box.
 *
 * What changed, and why:
 *
 *  - Results used to travel between pages in sessionStorage, with the URL
 *    reduced to "?search=true". Refreshing the results page then emptied it
 *    (the entry is read once and deleted), the back button showed nothing,
 *    and a result list could not be linked to anyone. The query now lives in
 *    the URL as ?q=..., which survives a refresh, a bookmark and a share.
 *    The old sessionStorage path is still honoured so an in-flight
 *    navigation from a cached page keeps working.
 *
 *  - User-Search.html carried its own private copy of searchFiles() that
 *    shadowed this one. Two implementations of one feature drift; there is
 *    one now, and it searches in place when the page can show results and
 *    navigates when it cannot.
 *
 *  - The result list says what it is: how many matches, for what, and - when
 *    the server had to fall back to close/fuzzy matches - that these are
 *    approximations rather than exact hits.
 */

/**
 * Escapes a value for safe insertion into innerHTML. File titles,
 * descriptions, categories and usernames are all user-supplied (any
 * logged-in user can set them via upload/profile), so every place that
 * builds a file card with a template literal + innerHTML must run them
 * through this first - otherwise a title like `<img src=x onerror=...>`
 * would execute in every other visitor's browser who sees that card
 * (stored XSS). Exposed on window so the inline card-rendering scripts on
 * the dashboard/search/favorites/file pages (which all load this file
 * first) can reuse the same function instead of each rolling their own.
 */
function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value === null || value === undefined ? '' : String(value);
    return div.innerHTML;
}
window.escapeHtml = escapeHtml;

const SEARCH_RESULTS_PAGE = '/views/User-Search.html';

function tr(key, fallback) {
    return (typeof window.t === 'function' ? window.t(key, fallback) : fallback);
}

function notifySearch(message, kind) {
    if (typeof window.showToast === 'function') window.showToast(message, kind);
    else alert(message);
}

/** The page's search input, whichever of the two conventions it uses. */
function searchInputEl() {
    return document.querySelector('.input-search') || document.getElementById('searchInput');
}

/** The results container, if this page is able to show results itself. */
function resultsContainerEl() {
    return document.getElementById('searchResults');
}

/**
 * The line above the results: "7 results for physics".
 * Created on demand so no page has to be edited to gain one.
 */
function summaryEl(container) {
    let summary = document.getElementById('searchSummary');
    if (!summary) {
        summary = document.createElement('div');
        summary.id = 'searchSummary';
        summary.className = 'search-summary';
        summary.setAttribute('role', 'status');
        summary.setAttribute('aria-live', 'polite');
        container.parentNode.insertBefore(summary, container);
    }
    return summary;
}

function renderSummary(container, query, files) {
    const summary = summaryEl(container);
    const count = Array.isArray(files) ? files.length : 0;

    if (!query) { summary.textContent = ''; summary.hidden = true; return; }
    summary.hidden = false;

    // Every row the server ranked only by edit distance is flagged _fuzzy.
    // If that is all we have, the honest headline is "closest files", not
    // "results" - the user misspelled something and deserves to be told.
    const approximate = count > 0 && files.every((file) => file._fuzzy);

    const label = count === 1
        ? tr('search.resultFor', 'result for')
        : tr('search.resultsFor', 'results for');

    // Some results can come from the embedding index - files that are about
    // the same subject without sharing any of the typed words. Saying so is
    // the difference between "clever" and "why is this here".
    const byMeaning = count > 0 && files.some((file) => file._semantic);

    const notes = [];
    if (approximate) notes.push(tr('search.approximate', 'No exact match - showing the closest files.'));
    if (byMeaning) notes.push(tr('search.someByMeaning', 'Some of these matched by topic rather than by wording.'));

    summary.innerHTML = count === 0
        ? `<span class="search-summary-count">${escapeHtml(tr('search.noResultsFor', 'Nothing matched'))}</span> ` +
          `<span class="search-summary-term">"${escapeHtml(query)}"</span>`
        : `<span class="search-summary-count">${count} ${escapeHtml(label)}</span> ` +
          `<span class="search-summary-term">"${escapeHtml(query)}"</span>` +
          notes.map((note) => `<span class="search-summary-note">${escapeHtml(note)}</span>`).join('');
}

function renderResults(query, files) {
    const container = resultsContainerEl() || document.querySelector('.container');
    if (!container) return;

    renderSummary(container, query, files);

    if (typeof window.renderFileCards !== 'function') {
        console.error('fileCard.js is not loaded on this page.');
        return;
    }

    // Cards are built by public/js/fileCard.js so search results look and
    // behave exactly like the cards on every other page (two-sided flip
    // included), instead of carrying their own copy of the markup.
    window.renderFileCards(container, files, {
        favorite: true,
        summarize: true,
        emptyIcon: 'fa fa-magnifying-glass',
        emptyKey: 'files.emptySearch',
        emptyMessage: 'No files match your search.'
    });
}

/**
 * Run a query against the API and show the results on this page.
 * @param {string} query
 * @param {{pushUrl?:boolean}} [options]
 */
async function runSearch(query, options = {}) {
    const term = String(query || '').trim();
    const container = resultsContainerEl() || document.querySelector('.container');
    if (!term || !container) return;

    if (options.pushUrl !== false) {
        const url = new URL(window.location.href);
        url.searchParams.set('q', term);
        url.searchParams.delete('search');
        window.history.replaceState({}, '', url);
    }

    const summary = summaryEl(container);
    summary.hidden = false;
    summary.textContent = tr('search.searching', 'Searching...');

    try {
        const response = await fetch(`/search-files?query=${encodeURIComponent(term)}`);
        if (!response.ok) throw new Error(`Search failed (${response.status})`);
        const files = await response.json();
        renderResults(term, files);
        window.lastSearchResults = files;
    } catch (error) {
        console.error('Error searching files:', error);
        summary.hidden = true;
        notifySearch(tr('search.failed', 'Search failed. Please try again.'), 'error');
    }
}

/** Entry point bound to the search button and the Enter key. */
function searchFiles() {
    const input = searchInputEl();
    if (!input) {
        console.error('Search input not found');
        return;
    }

    const value = input.value.trim();
    if (!value) {
        notifySearch(tr('search.empty', 'Please enter a search term.'), 'warning');
        return;
    }

    // A page that can display results does so; anywhere else, hand the query
    // to the results page in the URL rather than in session storage.
    if (resultsContainerEl()) runSearch(value);
    else window.location.href = `${SEARCH_RESULTS_PAGE}?q=${encodeURIComponent(value)}`;
}

document.addEventListener('DOMContentLoaded', () => {
    const searchButton = document.querySelector('.btn-search');
    if (searchButton) {
        searchButton.addEventListener('click', (event) => {
            event.preventDefault();
            searchFiles();
        });
    }

    const input = searchInputEl();
    if (input) {
        input.addEventListener('keypress', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                searchFiles();
            }
        });
    }

    const params = new URLSearchParams(window.location.search);
    const query = params.get('q');

    if (query && resultsContainerEl()) {
        if (input) input.value = query;
        runSearch(query, { pushUrl: false });
        return;
    }

    // Legacy path: a page cached before this change still hands results over
    // in sessionStorage with ?search=true.
    if (params.get('search') === 'true') {
        const stored = sessionStorage.getItem('searchResults');
        if (stored) {
            try {
                const files = JSON.parse(stored);
                const term = sessionStorage.getItem('searchQuery') || '';
                if (input && term) input.value = term;
                renderResults(term, files);
            } catch (error) {
                console.error('Could not read stored search results:', error);
            }
            sessionStorage.removeItem('searchResults');
            sessionStorage.removeItem('searchQuery');
        }
    }
});

// Re-render the summary line in the new language when the visitor switches.
window.addEventListener('sh:langchange', () => {
    const params = new URLSearchParams(window.location.search);
    const query = params.get('q');
    const container = resultsContainerEl();
    if (query && container && Array.isArray(window.lastSearchResults)) {
        renderSummary(container, query, window.lastSearchResults);
    }
});

function showSearchResultsOnPage(files) {
    const params = new URLSearchParams(window.location.search);
    renderResults(params.get('q') || '', files);
}

function displaySearchResults(files) {
    // Kept for any caller that still hands over a result array directly.
    sessionStorage.setItem('searchResults', JSON.stringify(files));
    window.location.href = `${SEARCH_RESULTS_PAGE}?search=true`;
}

window.searchFiles = searchFiles;
window.runSearch = runSearch;
window.showSearchResultsOnPage = showSearchResultsOnPage;
window.displaySearchResults = displaySearchResults;

if (typeof window.openFile !== 'function') {
    window.openFile = function (fileId) {
        window.location.href = `/views/Display.html?id=${encodeURIComponent(fileId)}`;
    };
}
