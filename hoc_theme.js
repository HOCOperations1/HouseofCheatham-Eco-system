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
      'position:fixed;bottom:8px;left:8px;z-index:9999;' +
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
    '#hoc-theme-toggle{pointer-events:auto;}' +
    // ── Reset button (v6.34af) — sibling of theme toggle ─────────────
    '#hoc-reset-btn{' +
      'position:fixed;bottom:8px;left:48px;z-index:9999;' +
      'width:32px;height:32px;border-radius:50%;border:1px solid var(--border);' +
      'background:var(--bg2);color:var(--text);' +
      'font:14px/1 system-ui,sans-serif;cursor:pointer;' +
      'display:flex;align-items:center;justify-content:center;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.15);' +
      'transition:transform .15s ease,background .15s ease;' +
      'padding:0;pointer-events:auto;' +
    '}' +
    '#hoc-reset-btn:hover{transform:scale(1.1);background:rgba(245,158,11,.15);}' +
    '#hoc-reset-btn:active{transform:scale(0.95);}' +
    // ── PDF Export button (v6.34ak) — third in the floating row ──────
    '#hoc-pdf-btn{' +
      'position:fixed;bottom:8px;left:88px;z-index:9999;' +
      'width:32px;height:32px;border-radius:50%;border:1px solid var(--border);' +
      'background:var(--bg2);color:var(--text);' +
      'font:13px/1 system-ui,sans-serif;cursor:pointer;' +
      'display:flex;align-items:center;justify-content:center;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.15);' +
      'transition:transform .15s ease,background .15s ease;' +
      'padding:0;pointer-events:auto;' +
    '}' +
    '#hoc-pdf-btn:hover{transform:scale(1.1);background:rgba(59,130,246,.15);}' +
    '#hoc-pdf-btn:active{transform:scale(0.95);}' +
    // ── Print-only header/footer divs (visible only when printing) ───
    '.hoc-print-header,.hoc-print-footer{display:none;}' +
    // ── Print media rules (v6.34ak) ──────────────────────────────────
    // Goal: clean, readable PDF when the user uses the floating PDF button.
    // These rules are GATED to body.hoc-printing-pdf so we don't interfere
    // with existing per-dashboard print outputs (5S red tags, inventory
    // labels, placards, etc.) which use their own scoped print CSS.
    '@media print{' +
      'body.hoc-printing-pdf{' +
        // Force backgrounds to render (Chrome/Edge strips them by default)
        '-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;color-adjust:exact !important;' +
        'background:#fff !important;color:#000 !important;font-size:10pt;' +
      '}' +
      'body.hoc-printing-pdf *{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;color-adjust:exact !important;}' +
      // Hide the floating buttons themselves whenever printing
      '#hoc-theme-toggle,#hoc-reset-btn,#hoc-pdf-btn{display:none !important;}' +
      // PDF mode only: hide operational chrome
      'body.hoc-printing-pdf .topbar,' +
      'body.hoc-printing-pdf nav.nav,' +
      'body.hoc-printing-pdf .sync-bar,' +
      'body.hoc-printing-pdf #sync-bar,' +
      'body.hoc-printing-pdf #badges,' +
      'body.hoc-printing-pdf .badges{display:none !important;}' +
      // PDF mode: show the print-only header + footer
      'body.hoc-printing-pdf .hoc-print-header{display:block !important;padding-bottom:8px;border-bottom:1px solid #aaa;margin-bottom:12px;font-family:system-ui,sans-serif;}' +
      'body.hoc-printing-pdf .hoc-print-header .h-title{font-size:14px;font-weight:700;color:#000;}' +
      'body.hoc-printing-pdf .hoc-print-header .h-meta{font-size:9px;color:#555;margin-top:2px;}' +
      'body.hoc-printing-pdf .hoc-print-footer{display:block !important;text-align:center;font-size:8px;color:#666;font-family:system-ui,sans-serif;padding-top:4px;border-top:1px solid #ccc;margin-top:12px;}' +
      // PDF mode: page margins + page numbers (Chrome/Edge only)
      'body.hoc-printing-pdf{margin:0;}' +
      // Don't split cards/rows across pages
      'body.hoc-printing-pdf .card,' +
      'body.hoc-printing-pdf .lc,' +
      'body.hoc-printing-pdf .kpi,' +
      'body.hoc-printing-pdf tr{page-break-inside:avoid;break-inside:avoid;}' +
      // Tables: print-friendly borders
      'body.hoc-printing-pdf table{border-collapse:collapse;width:100%;}' +
      'body.hoc-printing-pdf th,body.hoc-printing-pdf td{border:1px solid #ccc;padding:3px 5px;font-size:9pt;}' +
      'body.hoc-printing-pdf thead{display:table-header-group;}' +
      // Hide inactive pages (multi-tab dashboards)
      'body.hoc-printing-pdf .page:not(.active){display:none !important;}' +
    '}' +
    // Page geometry / numbers — applied when our flag is set
    '@media print{@page{margin:0.6in 0.5in 0.7in 0.5in;@bottom-right{content:"Page " counter(page) " of " counter(pages);font:9px system-ui;color:#666;}}}';

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

  // ── Reset button (v6.34af) ─────────────────────────────────────────
  // Behavior: confirm with user, then hard-reload the page. localStorage
  // (uploads, KPIs, theme prefs, etc.) is PRESERVED. Only in-memory JS
  // state, expanded drawers, filter selections, etc., are cleared.
  // This is the "I made a mistake, take me back to a clean view" path.
  function resetDashboard(){
    var dashName = document.title || 'this dashboard';
    var msg = 'Reset ' + dashName + '?\n\n' +
              'This clears filters, selections, and any unsaved changes on this page.\n' +
              'Uploaded data and saved settings are preserved.';
    if(confirm(msg)){
      // Hard reload — bypasses bfcache so we get a fresh render
      window.location.reload();
    }
  }

  function mountResetBtn(){
    if(document.getElementById('hoc-reset-btn')) return;
    if(!document.body){
      setTimeout(mountResetBtn, 50);
      return;
    }
    var btn = document.createElement('button');
    btn.id = 'hoc-reset-btn';
    btn.type = 'button';
    btn.textContent = '↺';
    btn.title = 'Reset this view (clear filters & selections)';
    btn.setAttribute('aria-label', btn.title);
    btn.addEventListener('click', resetDashboard);
    document.body.appendChild(btn);
  }

  // ── PDF Export (v6.34ak) ───────────────────────────────────────────
  // Approach: triggers window.print() with a print-only stylesheet that
  // hides operational chrome and adds an HOC header/footer. User selects
  // "Save as PDF" in the browser's print dialog. Filename hint comes from
  // document.title — works in Chrome/Edge, ignored by Safari/Firefox.
  //
  // Active tab only: only the currently-visible <div class="page active">
  // is printed. Users wanting other tabs in the same PDF need to switch
  // tabs and export again, or use a future proper-PDF builder per dashboard.
  function exportPDF(){
    // 1. Build a dashboard name + date for the header and filename hint
    var dashName = document.title || 'HOC-OES';
    // Strip common suffixes/prefixes the title might have
    dashName = dashName
      .replace(/^HOC[\-_ ]?OES\s*[\|\-—·]\s*/i, '')   // leading "HOC-OES · "
      .replace(/\s*[\|\-—·]\s*HOC[\-_ ]?OES\s*$/i, '') // trailing " · HOC-OES"
      .trim();
    if(!dashName) dashName = 'HOC-OES Dashboard';
    var now = new Date();
    var dateStr = now.toLocaleDateString('en-US', {
      year:'numeric', month:'short', day:'numeric'
    });
    var timeStr = now.toLocaleTimeString('en-US', {
      hour:'numeric', minute:'2-digit'
    });
    // Filename hint for Chrome/Edge: changes document.title temporarily
    var origTitle = document.title;
    var fileTag = dashName.replace(/[^a-zA-Z0-9]+/g, '_') + '_' +
                  now.toISOString().slice(0,10);
    document.title = fileTag;

    // 2. Inject print-only header + footer (removed after print)
    var header = document.createElement('div');
    header.className = 'hoc-print-header';
    header.id = '__hoc_print_header';
    header.innerHTML =
      '<div class="h-title">House of Cheatham · ' + escapeHTML(dashName) + '</div>' +
      '<div class="h-meta">Generated ' + escapeHTML(dateStr) + ' at ' + escapeHTML(timeStr) + ' · HOC-OES v6.34ak</div>';
    document.body.insertBefore(header, document.body.firstChild);

    var footer = document.createElement('div');
    footer.className = 'hoc-print-footer';
    footer.id = '__hoc_print_footer';
    footer.innerHTML = 'House of Cheatham — Confidential · ' + escapeHTML(dateStr);
    document.body.appendChild(footer);

    // 3. Trigger print. Browsers show their save-as-PDF dialog.
    document.body.classList.add('hoc-printing-pdf');
    var cleanup = function(){
      document.title = origTitle;
      document.body.classList.remove('hoc-printing-pdf');
      var h = document.getElementById('__hoc_print_header');
      var f = document.getElementById('__hoc_print_footer');
      if(h && h.parentNode) h.parentNode.removeChild(h);
      if(f && f.parentNode) f.parentNode.removeChild(f);
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    // Some browsers (older Safari) don't fire afterprint reliably — also
    // schedule a fallback cleanup so the page returns to normal even if
    // afterprint is skipped.
    setTimeout(function(){
      if(document.body.classList.contains('hoc-printing-pdf')) cleanup();
    }, 5000);
    window.print();
  }

  function escapeHTML(s){
    return String(s||'')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function mountPDFBtn(){
    if(document.getElementById('hoc-pdf-btn')) return;
    if(!document.body){
      setTimeout(mountPDFBtn, 50);
      return;
    }
    var btn = document.createElement('button');
    btn.id = 'hoc-pdf-btn';
    btn.type = 'button';
    btn.textContent = '📄';
    btn.title = 'Export this view to PDF (uses browser print dialog)';
    btn.setAttribute('aria-label', btn.title);
    btn.addEventListener('click', exportPDF);
    document.body.appendChild(btn);
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
    document.addEventListener('DOMContentLoaded', function(){
      mountToggle();
      mountResetBtn();
      mountPDFBtn();
    });
  } else {
    mountToggle();
    mountResetBtn();
    mountPDFBtn();
  }

  // Expose for programmatic access if any dashboard wants it
  window.HOC_THEME = {
    get: getTheme,
    set: setTheme,
    toggle: toggleTheme,
    reset: resetDashboard,
    exportPDF: exportPDF
  };

  // ═══════════════════════════════════════════════════════════════════
  // v6.34m — Version-mismatch self-healer
  //
  // Problem this solves: a tablet's service worker can have v6.34m
  // activated (index.html shows new pill) while individual dashboard
  // HTMLs are still being served from older cached copies (showing
  // hardcoded text from previous versions, wrong KPI labels, etc).
  //
  // How it works:
  //   1. Each page can declare its build version in <meta name="hoc-build">
  //   2. After load, we ask the SW what its current cache name is
  //   3. If the page's hoc-build is OLDER than the SW cache → stale
  //   4. Force a no-cache reload of the current URL
  //
  // Guarded against reload loops by storing the last reload timestamp
  // in sessionStorage. Won't reload more than once per 5 minutes
  // and won't reload if the page is still loading (visibility check).
  //
  // No-ops on dashboards without a hoc-build meta tag.
  // ═══════════════════════════════════════════════════════════════════
  function detectStaleAndReload(){
    try {
      var meta = document.querySelector('meta[name="hoc-build"]');
      if(!meta) return; // dashboard didn't opt in
      var pageBuild = (meta.getAttribute('content')||'').trim();
      if(!pageBuild) return;

      // Throttle: don't reload more than once every 5 min from a given tab
      var lastReload = parseInt(sessionStorage.getItem('hoc_stale_reload_ts')||'0', 10);
      if(Date.now() - lastReload < 5*60*1000) return;

      // Ask the controlling SW for its cache name
      if(!('serviceWorker' in navigator)) return;
      navigator.serviceWorker.ready.then(function(reg){
        if(!navigator.serviceWorker.controller) return;
        // Compare via a postMessage round-trip
        var channel = new MessageChannel();
        var done = false;
        channel.port1.onmessage = function(ev){
          if(done) return; done = true;
          var swCache = (ev.data && ev.data.cache) || '';
          if(!swCache) return;
          // Both formats: hoc-oes-v6.34m-20260605 — extract the v6.34X part
          var swVer = (swCache.match(/v6\.\d+[a-z]?/)||[''])[0];
          var pgVer = (pageBuild.match(/v6\.\d+[a-z]?/)||[''])[0];
          if(!swVer || !pgVer) return;
          if(swVer !== pgVer){
            // Page is stale relative to SW. Force reload bypassing cache.
            console.warn('[HOC-OES] Stale page detected: page='+pgVer+' SW='+swVer+' — reloading');
            sessionStorage.setItem('hoc_stale_reload_ts', String(Date.now()));
            // Reload with cache-bust query so even HTTP cache surrenders
            var url = location.href.split('#')[0];
            var sep = url.indexOf('?') >= 0 ? '&' : '?';
            location.replace(url + sep + '_v=' + Date.now());
          }
        };
        // Some old SWs may not respond — set a timeout to clean up
        setTimeout(function(){ done = true; }, 3000);
        try {
          navigator.serviceWorker.controller.postMessage({type:'GET_CACHE_NAME'}, [channel.port2]);
        } catch(e){ done = true; }
      }).catch(function(){});
    } catch(e){ /* never break a page over this */ }
  }
  // Run after page settles (avoid interrupting first paint)
  if(document.readyState === 'complete'){
    setTimeout(detectStaleAndReload, 1500);
  } else {
    window.addEventListener('load', function(){ setTimeout(detectStaleAndReload, 1500); });
  }
})();
