// ═══════════════════════════════════════════════════════════════════════
// hoc_updater.js
// ═══════════════════════════════════════════════════════════════════════
// v6.34cf — Shared updater module. Included on every dashboard + index.
//
// What it does:
//   1. Renders a small, subtle version chip in the corner (always visible).
//   2. Detects when a new service worker is waiting.
//   3. When update is ready, chip turns amber "🔄 update ready · tap to apply".
//   4. Auto-reload triggers only when SAFE — no modal open, no input focus,
//      user has been idle 30+ seconds. Prevents interrupting operators
//      mid-verification, mid-shortage-entry, mid-placard-print.
//   5. Tap the chip = manual immediate reload (skips safety wait).
//   6. Polls for updates every 60 seconds while page is open.
//
// Idle detection: any click/keydown/touch/mousemove resets the idle timer.
// Modal detection: any element with common modal/overlay/dialog id/class
// that's currently visible blocks auto-reload.
//
// This module is idempotent — safe to include multiple times.
// ═══════════════════════════════════════════════════════════════════════
(function(){
  'use strict';
  if (window.__HOC_UPDATER_LOADED__) return;
  window.__HOC_UPDATER_LOADED__ = true;
  if (!('serviceWorker' in navigator)) return;

  // ── Config ──────────────────────────────────────────────────────────
  var IDLE_MS              = 30 * 1000;       // must be idle this long
  var COUNTDOWN_MS         = 10 * 1000;       // countdown before auto-reload
  var UPDATE_POLL_MS       = 60 * 1000;       // how often to check for new SW
  var IS_INDEX             = /(?:^|\/)index\.html?$/.test(location.pathname) ||
                             location.pathname.endsWith('/') ||
                             location.pathname === '';

  // ── Version detection ──────────────────────────────────────────────
  var currentVersion = '';
  try {
    // Check any of the meta-name variants HOC-OES has used
    var meta = document.querySelector('meta[name="hoc-oes-version"]') ||
               document.querySelector('meta[name="hoc-build"]') ||
               document.querySelector('meta[name="version"]');
    if (meta) currentVersion = meta.getAttribute('content') || '';
  } catch (e) {}

  // ── State ──────────────────────────────────────────────────────────
  var chip = null;
  var updateReady = false;
  var reloading = false;
  var lastInteraction = Date.now();
  var idleWatcher = null;
  var countdownWatcher = null;

  // ── Idle tracking ──────────────────────────────────────────────────
  ['click','keydown','touchstart','mousemove','input','change'].forEach(function(ev){
    document.addEventListener(ev, function(){
      lastInteraction = Date.now();
      // If a countdown was running and user interacted, abort it
      if (countdownWatcher) {
        clearInterval(countdownWatcher);
        countdownWatcher = null;
        if (updateReady) setChipUpdateReady();
      }
    }, {passive: true, capture: true});
  });

  // ── Modal detection ────────────────────────────────────────────────
  // Returns true if any modal-ish element is currently visible.
  // Broad enough to catch HOC's shortage dialog, PC/CC placards in
  // print-preview mode, and any future overlay.
  function anyModalOpen(){
    var candidates = document.querySelectorAll(
      '[id$="dialog"], [id$="-dlg"], [id*="modal"], [id*="overlay"], ' +
      '[class*="modal"], [class*="overlay"], .no-print[style*="display:flex"]'
    );
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el.offsetParent === null) continue;
      var s = getComputedStyle(el);
      if (s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0) {
        return true;
      }
    }
    return false;
  }

  function inputHasFocus(){
    var a = document.activeElement;
    if (!a) return false;
    var tag = a.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (a.isContentEditable) return true;
    return false;
  }

  function isSafeToReload(){
    if (Date.now() - lastInteraction < IDLE_MS) return false;
    if (anyModalOpen()) return false;
    if (inputHasFocus()) return false;
    return true;
  }

  // ── Chip UI ────────────────────────────────────────────────────────
  function createChip(){
    if (chip) return;
    chip = document.createElement('div');
    chip.id = 'hoc-updater-chip';
    chip.setAttribute('role', 'status');
    chip.setAttribute('aria-live', 'polite');
    chip.style.cssText = [
      'position:fixed',
      'bottom:8px',
      'right:8px',
      'z-index:99999',
      'background:rgba(20,25,35,.75)',
      'color:#8899aa',
      'font:11px ui-monospace,SFMono-Regular,Menlo,monospace',
      'padding:3px 9px',
      'border-radius:12px',
      'border:1px solid rgba(255,255,255,.06)',
      'user-select:none',
      'pointer-events:none',
      'transition:all .2s ease',
      'cursor:default',
      // Print: hide the chip
      'print-color-adjust:exact'
    ].join(';');
    // Also hide on print via inline @media rule
    if (!document.getElementById('hoc-updater-print-style')) {
      var st = document.createElement('style');
      st.id = 'hoc-updater-print-style';
      st.textContent = '@media print { #hoc-updater-chip { display: none !important; } }';
      document.head && document.head.appendChild(st);
    }
    document.body.appendChild(chip);
    setChipIdle();
  }

  function setChipIdle(){
    if (!chip) return;
    chip.textContent = currentVersion || 'v?';
    chip.style.background = 'rgba(20,25,35,.75)';
    chip.style.color = '#8899aa';
    chip.style.borderColor = 'rgba(255,255,255,.06)';
    chip.style.pointerEvents = 'none';
    chip.style.cursor = 'default';
    chip.onclick = null;
    chip.title = 'HOC-OES ' + (currentVersion || 'unknown version');
  }

  function setChipUpdateReady(){
    if (!chip) createChip();
    if (!chip) return;
    updateReady = true;
    chip.innerHTML = '🔄 update ready · tap to apply';
    chip.style.background = 'rgba(245,196,82,.95)';
    chip.style.color = '#3a2a00';
    chip.style.borderColor = '#5a4200';
    chip.style.pointerEvents = 'auto';
    chip.style.cursor = 'pointer';
    chip.title = 'A newer version of HOC-OES is ready. Tap to reload now.';
    chip.onclick = doUpdate;
  }

  function setChipCountdown(seconds){
    if (!chip) return;
    chip.innerHTML = '🔄 auto-updating in ' + seconds + 's · tap to update now';
    chip.style.background = 'rgba(76,175,80,.95)';
    chip.style.color = '#0a2a10';
    chip.style.borderColor = '#1b5e20';
    chip.style.pointerEvents = 'auto';
    chip.style.cursor = 'pointer';
    chip.onclick = doUpdate;
  }

  function setChipUpdating(){
    if (!chip) return;
    chip.innerHTML = '⏳ updating…';
    chip.style.pointerEvents = 'none';
    chip.style.cursor = 'default';
    chip.onclick = null;
  }

  // ── Reload orchestration ───────────────────────────────────────────
  function doUpdate(){
    if (reloading) return;
    reloading = true;
    setChipUpdating();
    // Tell any waiting SW to activate. On controllerchange we'll reload.
    navigator.serviceWorker.getRegistration().then(function(reg){
      var target = (reg && (reg.waiting || reg.installing)) || null;
      if (target) {
        try { target.postMessage({type:'SKIP_WAITING'}); } catch(e){}
        try { target.postMessage('SKIP_WAITING'); } catch(e){} // legacy string form
      }
      // Fallback: reload after brief delay even if SW didn't respond
      setTimeout(function(){
        if (reloading) location.reload();
      }, 800);
    }).catch(function(){
      location.reload();
    });
  }

  function scheduleAutoReload(){
    if (idleWatcher) return;
    idleWatcher = setInterval(function(){
      if (!updateReady || reloading) {
        clearInterval(idleWatcher);
        idleWatcher = null;
        return;
      }
      if (!isSafeToReload()) return;
      // Safe. Begin countdown.
      clearInterval(idleWatcher);
      idleWatcher = null;
      var remaining = Math.floor(COUNTDOWN_MS / 1000);
      setChipCountdown(remaining);
      countdownWatcher = setInterval(function(){
        if (!isSafeToReload()) {
          // User came back — cancel countdown, resume watching
          clearInterval(countdownWatcher);
          countdownWatcher = null;
          setChipUpdateReady();
          scheduleAutoReload();
          return;
        }
        remaining--;
        if (remaining <= 0) {
          clearInterval(countdownWatcher);
          countdownWatcher = null;
          doUpdate();
        } else {
          setChipCountdown(remaining);
        }
      }, 1000);
    }, 3000);
  }

  // ── SW registration & update watching ──────────────────────────────
  // Only index.html registers the SW; dashboards inherit the same
  // registration since they're in the same scope. But dashboards STILL
  // need to listen for updatefound in case the user navigates to a
  // dashboard first (bookmark, deep link).
  function watchRegistration(reg){
    if (!reg) return;
    // Already-waiting SW (installed but not yet controlling)
    if (reg.waiting && navigator.serviceWorker.controller) {
      setChipUpdateReady();
      scheduleAutoReload();
    }
    reg.addEventListener('updatefound', function(){
      var installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', function(){
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          setChipUpdateReady();
          scheduleAutoReload();
        }
      });
    });
    // Poll for updates
    setInterval(function(){
      reg.update().catch(function(){});
    }, UPDATE_POLL_MS);
  }

  if (IS_INDEX) {
    navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'})
      .then(watchRegistration)
      .catch(function(e){ console.warn('[hoc_updater] SW register failed:', e); });
  } else {
    navigator.serviceWorker.ready.then(watchRegistration).catch(function(){});
    // Also grab any existing registration so we can listen even if
    // controller isn't yet set (first visit to a dashboard).
    navigator.serviceWorker.getRegistration().then(watchRegistration).catch(function(){});
  }

  // Listen for SW_UPDATED message from newly activated worker
  navigator.serviceWorker.addEventListener('message', function(e){
    if (e.data && e.data.type === 'SW_UPDATED') {
      // The new SW has activated. This page is running old code.
      setChipUpdateReady();
      scheduleAutoReload();
    }
  });

  // When the controller changes (new SW took over), reload.
  navigator.serviceWorker.addEventListener('controllerchange', function(){
    if (reloading) return;
    // If it's safe, reload immediately; otherwise show update-ready chip
    // and let the safe-reload logic handle it.
    if (isSafeToReload()) {
      reloading = true;
      location.reload();
    } else {
      setChipUpdateReady();
      scheduleAutoReload();
    }
  });

  // Boot the chip UI
  if (document.body) {
    createChip();
  } else {
    document.addEventListener('DOMContentLoaded', createChip);
  }
})();
