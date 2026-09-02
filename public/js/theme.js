// Site-wide dark/light theme toggle. Self-contained: applies the saved (or
// system) preference immediately (before first paint, to avoid a flash of
// the wrong theme), then injects a small floating toggle button into every
// page that includes this script - no per-page markup needed.
(function () {
  var STORAGE_KEY = 'sh-theme';

  function getPreferredTheme() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch (e) { /* localStorage unavailable (e.g. private mode) - fall through */ }
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }

  function updateToggleIcon(theme) {
    var btn = document.getElementById('shThemeToggle');
    if (btn) btn.innerHTML = theme === 'dark' ? '<i class="fa fa-sun"></i>' : '<i class="fa fa-moon"></i>';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    updateToggleIcon(theme);
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme') || 'light';
    var next = current === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* ignore */ }
    applyTheme(next);
  }
  window.toggleTheme = toggleTheme;

  // Apply as early as possible (this script runs in <head>, right after
  // design-system.css) so there's no flash of the wrong theme on load.
  applyTheme(getPreferredTheme());

  document.addEventListener('DOMContentLoaded', function () {
    if (document.getElementById('shThemeToggle')) return;

    var btn = document.createElement('button');
    btn.id = 'shThemeToggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'تبديل المظهر الليلي/النهاري');
    btn.title = 'تبديل المظهر الليلي/النهاري';
    btn.style.cssText = [
      'position:fixed', 'bottom:20px', 'inset-inline-end:20px', 'z-index:999',
      'width:46px', 'height:46px', 'border-radius:50%',
      'border:1px solid var(--sh-line)', 'background:var(--sh-surface)',
      'color:var(--sh-ink)', 'box-shadow:var(--sh-shadow-lg)', 'cursor:pointer',
      'display:flex', 'align-items:center', 'justify-content:center',
      'font-size:1.1rem', 'transition:transform .2s ease, background .2s ease'
    ].join(';');
    btn.addEventListener('mouseenter', function () { btn.style.transform = 'scale(1.08)'; });
    btn.addEventListener('mouseleave', function () { btn.style.transform = 'scale(1)'; });
    btn.addEventListener('click', toggleTheme);

    document.body.appendChild(btn);
    updateToggleIcon(document.documentElement.getAttribute('data-theme') || 'light');
  });
})();
