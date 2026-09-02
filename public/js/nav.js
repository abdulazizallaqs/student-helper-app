/**
 * Shared navigation bar.
 *
 * Every page ships the same flat list of icon links inside `.navbar`. This
 * script rearranges that list into three zones and adds the controls that
 * are not page navigation:
 *
 *      [ account ]        [ browse - browse - browse ]        [ AR/EN  logout ]
 *        start                     centre                          end
 *
 * Why here instead of in each page's HTML: there are twelve pages carrying
 * this bar. Editing twelve copies is how they drifted apart in the first
 * place (one page was missing the AI link, another linked to a filename that
 * does not exist on a case-sensitive server). One implementation, applied on
 * load, cannot drift.
 */
(function () {
  'use strict';

  /** Translate, falling back to the English text if i18n.js has not loaded. */
  function t(key, fallback) {
    return (typeof window.t === 'function' ? window.t(key, fallback) : fallback) || fallback;
  }

  /**
   * End the session and return to the login page.
   *
   * POST, not a plain link: logging out changes state, and the CSRF origin
   * check in middleware/csrf.js only inspects state-changing methods. As a
   * GET link, an `<img src="https://the-app/logout">` on any other page the
   * student visits would sign them out. (GET /logout still exists so the
   * admin dashboard's existing anchor and old bookmarks keep working.)
   */
  async function logout() {
    try {
      const response = await fetch('/logout', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      let target = '/login';
      if (response.ok) {
        const data = await response.json().catch(() => null);
        if (data && data.redirect) target = data.redirect;
      }
      // `replace` so Back cannot return to a page with no session behind it.
      window.location.replace(target);
    } catch (error) {
      console.error('Logout request failed:', error);
      // Network down or the server is gone: fall back to the GET route so the
      // user is never stuck logged in with no way out.
      window.location.replace('/logout');
    }
  }

  function makeZone(name) {
    const zone = document.createElement('div');
    zone.className = 'navbar-zone navbar-' + name;
    return zone;
  }

  function buildLogoutButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'navy navy-logout';
    button.id = 'nav-logout';
    button.innerHTML = '<i class="fa fa-right-from-bracket" aria-hidden="true"></i>';
    button.dataset.i18nTitle = 'nav.logout';
    button.dataset.i18nAria = 'nav.logout';
    button.title = t('nav.logout', 'Log out');
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', () => {
      if (window.confirm(t('nav.logoutConfirm', 'Log out of Student Helper?'))) logout();
    });
    return button;
  }

  function decorateNavbar(navbar) {
    if (navbar.dataset.shNav === 'done') return;
    navbar.dataset.shNav = 'done';

    const items = Array.from(navbar.children);
    const start = makeZone('start');
    const centre = makeZone('centre');
    const end = makeZone('end');

    items.forEach((item) => {
      const href = (item.getAttribute('href') || '').toLowerCase();
      // The account link is pulled out to its own side of the bar; everything
      // else stays together in the middle as page navigation.
      if (href.includes('profile.html') || href.includes('account-info')) {
        item.classList.add('navy-account');
        if (!item.title) item.title = t('nav.account', 'My account');
        item.dataset.i18nTitle = 'nav.account';
        start.appendChild(item);
      } else {
        centre.appendChild(item);
      }
    });

    // No account link on this page (e.g. the admin dashboard): keep the
    // three-zone grid balanced rather than letting the centre drift.
    if (!start.children.length) {
      const account = document.createElement('a');
      account.href = '/views/profile.html';
      account.className = 'navy navy-account';
      account.title = t('nav.account', 'My account');
      account.dataset.i18nTitle = 'nav.account';
      account.innerHTML = '<i class="fa fa-user-circle" aria-hidden="true"></i>';
      start.appendChild(account);
    }

    // The language switch used to sit here. It now lives at the top of the
    // page (public/js/i18n.js builds it) rather than inside the navigation:
    // choosing a language is a setting for the whole site, not a place to go,
    // and the pages without a navbar - the splash page, login, create-account -
    // could not offer it from here at all.
    end.appendChild(buildLogoutButton());

    navbar.replaceChildren(start, centre, end);

    // Highlight the page you are on - the bar is identical everywhere, so
    // without this there is no indication of where you are.
    const here = window.location.pathname.toLowerCase();
    navbar.querySelectorAll('a.navy').forEach((link) => {
      const href = (link.getAttribute('href') || '').toLowerCase();
      const leaf = href.split('/').pop();
      if (leaf && here.endsWith(leaf)) {
        link.classList.add('is-current');
        link.setAttribute('aria-current', 'page');
      }
    });

    // Titles added above are plain English until i18n.js has a dictionary.
    if (typeof window.applyLang === 'function') {
      window.applyLang(document.documentElement.getAttribute('lang') === 'ar' ? 'ar' : 'en');
    }
  }

  function decorateNavbars() {
    document.querySelectorAll('.navbar').forEach(decorateNavbar);
  }

  window.logout = logout;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', decorateNavbars);
  } else {
    decorateNavbars();
  }
})();
