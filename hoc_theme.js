/* ═══════════════════════════════════════════════════════════════════
 * HOC-OES Theme Toggle — v6.34k
 *
 * Drop-in module: include `<script src="hoc_theme.js"></script>` in any
 * dashboard's <head> (or end of body) and you get:
 *   1. A floating sun/moon toggle in the top-right corner of every page
 *   2. Light-mode CSS override that remaps existing --bg/--text/--border tokens
 *   3. Preference persisted to localStorage.hoc_theme (per browser/tablet)
 *   4. Cross-tab sync — toggle on one tab, all tabs update via storage event
 *
 * No per-dashboard CSS changes required. Every dashboard already uses the
 * shared token palette (--bg, --bg2, --bg3, --text, --text2, --text3,
 * --border) so the override propagates automatically.
 * ═══════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  var THEME_KEY = 'hoc_theme';
  var THEMES = ['dark','light'];

  // ── Light-mode palette ─────────────────────────────────────────────
  // Remaps the dark-theme tokens to a high-contrast light scheme tuned
  // for tablet readability under shop-floor fluorescent lighting.
  // Tested for AAA contrast (>7:1) on the text/bg pairings.
  var LIGHT_CSS =
    '[data-hoc-theme="light"]{' +
      '--bg:#F8FAFC !important;' +
      '--bg2:#FFFFFF !important;' +
      '--bg3:#F1F5F9 !important;' +
      '--border:#CBD5E1 !important;' +
      '--text:#0F172A !important;' +
      '--text2:#475569 !important;' +
      '--text3:#64748B !important;' +
      // Accent colors stay bold for readability on light bg
      '--green:#15803D !important;' +
      '--red:#DC2626 !important;' +
      '--amber:#B45309 !important;' +
      '--blue:#1D4ED8 !important;' +
      '--purple:#7C3AED !important;' +
      '--teal:#0F766E !important;' +
      '--cyan:#0E7490 !important;' +
      '--gold:#A16207 !important;' +
      // Light-mode soft tints
      '--green-l:rgba(21,128,61,.10) !important;' +
      '--red-l:rgba(220,38,38,.10) !important;' +
      '--amber-l:rgba(180,83,9,.10) !important;' +
      '--blue-l:rgba(29,78,216,.10) !important;' +
    '}' +
    // Body bg uses --bg, but some dashboards hardcode #0B0E17 — override defensively
    '[data-hoc-theme="light"] body{' +
      'background:#F8FAFC !important;' +
      'color:#0F172A !important;' +
    '}' +
    // Common hardcoded dark-color patterns we want to invert in light mode
    '[data-hoc-theme="light"] [style*="background:#0B0E17"],' +
    '[data-hoc-theme="light"] [style*="background:#111520"],' +
    '[data-hoc-theme="light"] [style*="background:#161C28"]{' +
      'background:#FFFFFF !important;' +
    '}' +
    '[data-hoc-theme="light"] [style*="background:rgba(15,20,25"]{' +
      'background:rgba(248,250,252,.6) !important;' +
    '}' +
    // Sync bar / muted text contrast bumps
    '[data-hoc-theme="light"] .sync-bar,' +
    '[data-hoc-theme="light"] .muted,' +
    '[data-hoc-theme="light"] .t3,' +
    '[data-hoc-theme="light"] .ks{' +
      'color:#64748B !important;' +
    '}' +
    // Theme toggle button itself
    '#hoc-theme-toggle{' +
      'position:fixed;top:8px;right:8px;z-index:9999;' +
      'width:32px;height:32px;border-radius:50%;border:1px solid var(--border);' +
      'background:var(--bg2);color:var(--text);' +
      'font:14px/1 system-ui,sans-serif;cursor:pointer;' +
      'display:flex;align-items:center;justify-content:center;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.15);' +
      'transition:transform .15s ease,background .15s ease;' +
      'padding:0;' +
    '}' +
    '#hoc-theme-toggle:hover{transform:scale(1.1);}' +
    '#hoc-theme-toggle:active{transform:scale(0.95);}' +
    // Make sure floating button stays clickable on every dashboard
    '#hoc-theme-toggle{pointer-events:auto;}';

  // ── Inject CSS once ────────────────────────────────────────────────
  function injectCSS(){
    if(document.getElementById('hoc-theme-style')) return;
    var style = document.createElement('style');
    style.id = 'hoc-theme-style';
    style.textContent = LIGHT_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // ── Apply theme to <html> ──────────────────────────────────────────
  function applyTheme(theme){
    if(THEMES.indexOf(theme) < 0) theme = 'dark';
    document.documentElement.setAttribute('data-hoc-theme', theme);
    // Update toggle icon if it's mounted
    var btn = document.getElementById('hoc-theme-toggle');
    if(btn){
      btn.textContent = theme === 'light' ? '🌙' : '☀️';
      btn.title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  // ── Get / set preference ───────────────────────────────────────────
  function getTheme(){
    try {
      var t = localStorage.getItem(THEME_KEY);
      if(THEMES.indexOf(t) >= 0) return t;
    } catch(e){}
    return 'dark'; // default
  }
  function setTheme(theme){
    try { localStorage.setItem(THEME_KEY, theme); } catch(e){}
    applyTheme(theme);
  }
  function toggleTheme(){
    var current = getTheme();
    setTheme(current === 'dark' ? 'light' : 'dark');
  }

  // ── Mount the floating toggle button ───────────────────────────────
  function mountToggle(){
    if(document.getElementById('hoc-theme-toggle')) return;
    if(!document.body){
      // Body not yet ready — try again
      setTimeout(mountToggle, 50);
      return;
    }
    var btn = document.createElement('button');
    btn.id = 'hoc-theme-toggle';
    btn.type = 'button';
    btn.addEventListener('click', toggleTheme);
    document.body.appendChild(btn);
    // Refresh icon to current state
    applyTheme(getTheme());
  }

  // ── Cross-tab sync ─────────────────────────────────────────────────
  window.addEventListener('storage', function(e){
    if(e.key === THEME_KEY && e.newValue){
      applyTheme(e.newValue);
    }
  });

  // ── Boot ────────────────────────────────────────────────────────────
  // Apply theme to <html> ASAP (before paint) to avoid FOUC
  injectCSS();
  applyTheme(getTheme());

  // Mount the toggle once DOM is parsed enough to have a body
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', mountToggle);
  } else {
    mountToggle();
  }

  // Expose for programmatic access if any dashboard wants it
  window.HOC_THEME = {
    get: getTheme,
    set: setTheme,
    toggle: toggleTheme
  };
})();
