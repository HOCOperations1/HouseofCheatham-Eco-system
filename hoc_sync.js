// ═══════════════════════════════════════════════════════════════════════
// hoc_sync.js
// ═══════════════════════════════════════════════════════════════════════
// v6.34ch — Shared cross-device sync module.
//
// What it does:
//   - Every localStorage.setItem() for a whitelisted "sync key" auto-pushes
//     to Supabase (debounced 800ms).
//   - Every 30 seconds, polls Supabase for changes. If any sync key has
//     been updated by another device, pulls it and updates local storage.
//   - Fires a `hoc-sync-updated` DOM event when remote changes are applied,
//     so dashboards can refresh their UI without a page reload.
//   - A small indicator next to the topbar sync pill shows sync status.
//
// Architecture:
//   - Table: hoc_sync_bus (id=1, updated_at, payload jsonb)  [exists]
//   - Each sync key lives under payload["hoc_XXX_v1"] as {data, _ts, _dev}
//   - Poll fetches only updated_at (light); if newer than local last-seen,
//     fetches the full payload once.
//   - Push is debounced to avoid overwhelming Supabase during rapid edits.
//   - Local device ID prevents feedback loops (device won't apply changes
//     it just pushed).
//
// Not synced (per-device by design):
//   - hoc_line_filter_v1, hoc_theme_v1, hoc_oes_version, hoc_upload_log_v1,
//     hoc_sync_v1 (local activity counter — different from this bus).
//
// Note: hoc_upload_v1 (Planning_Data batches) is EXCLUDED here — it's
// synced via the pre-existing hoc_schedule table + broadcastSchedule().
// Leaving that path alone to avoid dual writes.
// ═══════════════════════════════════════════════════════════════════════
(function(){
  'use strict';
  if(window.__HOC_SYNC_LOADED__) return;
  window.__HOC_SYNC_LOADED__ = true;

  var SUPA_URL = 'https://yemtpvrumqvbzrzpwnyy.supabase.co';
  var SUPA_KEY = 'sb_publishable_YrMf3_sGly4dir1cEGErfg_SSusnfJl';
  var H = function(){
    return {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Content-Type': 'application/json'
    };
  };

  var POLL_MS  = 30 * 1000;
  var PUSH_DEBOUNCE_MS = 800;

  // ── Sync key registry ─────────────────────────────────────────────
  // Only these keys are pushed/pulled. Everything else is per-device.
  var SYNC_KEYS = [
    // Data Hub uploads
    'hoc_line_setup_v1',
    'hoc_line_setup_manual_v1',
    'hoc_po_report_v1',
    'hoc_labor_standards_v1',
    'hoc_patch_oee_v1',
    'hoc_patch_stops_v1',
    'hoc_next_month_v1',
    'hoc_kpi_manual_v1',
    'hoc_attainment_v1',
    'hoc_chem_pulls_req_v1',
    'hoc_scrap_v1',
    'hoc_changeovers_auto_v1',
    'hoc_changeover_data_v1',
    // Floor state
    'hoc_inventory_tanks_v1',
    'hoc_inventory_raw_tanks_v1',
    'hoc_tank_state_v1',
    'hoc_tank_config_v1',
    'hoc_placard_locations_v1',
    'hoc_cc_item_verified_v1',
    'hoc_floor_v1'
  ];

  // ── Device ID ─────────────────────────────────────────────────────
  var deviceId = localStorage.getItem('hoc_device_id_v1');
  if(!deviceId){
    deviceId = 'dev_' + Math.random().toString(36).substr(2, 12) + '_' + Date.now().toString(36);
    localStorage.setItem('hoc_device_id_v1', deviceId);
  }

  // ── Local state ───────────────────────────────────────────────────
  var pendingTimers = {};       // key -> setTimeout handle
  var lastSeenServerTs = null;   // updated_at from last successful pull
  var lastAppliedByKey = {};     // key -> _ts we've already applied
  var pollHandle = null;
  var _statusEl = null;

  // Load prior last-applied map (survives reload)
  try {
    var savedMeta = JSON.parse(localStorage.getItem('hoc_sync_meta_v1') || '{}');
    lastAppliedByKey = savedMeta.lastAppliedByKey || {};
    lastSeenServerTs = savedMeta.lastSeenServerTs || null;
  } catch(e){}

  function persistMeta(){
    try {
      _originalSetItem('hoc_sync_meta_v1', JSON.stringify({
        lastAppliedByKey: lastAppliedByKey,
        lastSeenServerTs: lastSeenServerTs
      }));
    } catch(e){}
  }

  // ── setItem wrapper — auto-push on syncable keys ──────────────────
  var _originalSetItem = localStorage.setItem.bind(localStorage);
  var _wrappedSet = function(k, v){
    _originalSetItem(k, v);
    if(SYNC_KEYS.indexOf(k) >= 0){
      schedulePush(k, v);
    }
  };
  // Attach wrapper. Some code assumes localStorage.setItem is a plain
  // function; wrapping is safe because we still call the original.
  try { localStorage.setItem = _wrappedSet; } catch(e){}

  function schedulePush(key, rawValue){
    if(pendingTimers[key]) clearTimeout(pendingTimers[key]);
    pendingTimers[key] = setTimeout(function(){
      delete pendingTimers[key];
      pushKey(key, rawValue);
    }, PUSH_DEBOUNCE_MS);
  }

  // ── PUSH: fetch-modify-write one key into payload ────────────────
  function pushKey(key, rawValue){
    var parsed;
    try { parsed = JSON.parse(rawValue); } catch(e){ parsed = rawValue; }
    setStatus('pushing');
    fetch(SUPA_URL + '/rest/v1/hoc_sync_bus?id=eq.1&select=payload', {headers: H()})
      .then(function(r){ return r.ok ? r.json() : []; })
      .then(function(arr){
        var payload = (arr[0] && arr[0].payload) || {};
        var ts = new Date().toISOString();
        payload[key] = {data: parsed, _ts: ts, _dev: deviceId};
        // Remember what we pushed so we don't pull-apply our own change
        lastAppliedByKey[key] = ts;
        persistMeta();
        return fetch(SUPA_URL + '/rest/v1/hoc_sync_bus?id=eq.1', {
          method: 'PATCH',
          headers: Object.assign({}, H(), {'Prefer':'return=minimal'}),
          body: JSON.stringify({updated_at: ts, payload: payload})
        });
      })
      .then(function(r){
        // If PATCH failed with 404/406 (no row yet), try POST to create
        if(r && !r.ok && (r.status === 404 || r.status === 406)){
          var ts2 = new Date().toISOString();
          var newPayload = {}; newPayload[key] = {data: parsed, _ts: ts2, _dev: deviceId};
          lastAppliedByKey[key] = ts2;
          persistMeta();
          return fetch(SUPA_URL + '/rest/v1/hoc_sync_bus', {
            method: 'POST',
            headers: Object.assign({}, H(), {'Prefer':'resolution=merge-duplicates,return=minimal'}),
            body: JSON.stringify({id: 1, updated_at: ts2, payload: newPayload})
          });
        }
        return r;
      })
      .then(function(r){
        if(r && r.ok){ setStatus('synced'); }
        else { setStatus('error'); console.warn('[hoc_sync] push failed:', r && r.status); }
      })
      .catch(function(e){
        setStatus('error');
        console.warn('[hoc_sync] push exception:', e.message);
      });
  }

  // ── PULL: check for changes, apply if newer ──────────────────────
  function pullApply(){
    // Head-check: fetch only updated_at (small)
    fetch(SUPA_URL + '/rest/v1/hoc_sync_bus?id=eq.1&select=updated_at', {headers: H()})
      .then(function(r){ return r.ok ? r.json() : []; })
      .then(function(arr){
        var row = arr[0];
        if(!row || !row.updated_at) return null;
        // Skip full fetch if nothing changed since last time
        if(lastSeenServerTs && row.updated_at <= lastSeenServerTs) return null;
        // Fetch full payload
        return fetch(SUPA_URL + '/rest/v1/hoc_sync_bus?id=eq.1&select=payload,updated_at', {headers: H()})
          .then(function(r){ return r.ok ? r.json() : []; })
          .then(function(a){ return a[0]; });
      })
      .then(function(row){
        if(!row || !row.payload) return;
        var changedKeys = [];
        SYNC_KEYS.forEach(function(k){
          var remote = row.payload[k];
          if(!remote || !remote.data || !remote._ts) return;
          // Skip if remote was pushed by this device
          if(remote._dev === deviceId) return;
          // Skip if we've already applied this timestamp
          if(lastAppliedByKey[k] === remote._ts) return;
          if(lastAppliedByKey[k] && lastAppliedByKey[k] >= remote._ts) return;
          // Apply — use ORIGINAL setItem to avoid re-triggering push
          try {
            _originalSetItem(k, JSON.stringify(remote.data));
            lastAppliedByKey[k] = remote._ts;
            changedKeys.push(k);
          } catch(e){
            console.warn('[hoc_sync] apply failed for', k, e.message);
          }
        });
        lastSeenServerTs = row.updated_at;
        persistMeta();
        if(changedKeys.length){
          console.log('[hoc_sync] applied changes:', changedKeys.join(', '));
          window.dispatchEvent(new CustomEvent('hoc-sync-updated', {detail: {keys: changedKeys}}));
          setStatus('synced', changedKeys.length);
        } else {
          setStatus('synced');
        }
      })
      .catch(function(e){
        setStatus('error');
        console.warn('[hoc_sync] pull exception:', e.message);
      });
  }

  // ── UI indicator ─────────────────────────────────────────────────
  function createStatusEl(){
    if(_statusEl) return _statusEl;
    _statusEl = document.createElement('div');
    _statusEl.id = 'hoc-sync-status';
    _statusEl.style.cssText = [
      'position:fixed',
      'bottom:8px',
      'right:135px',  // to the left of the version chip (which is right:8px + ~120px wide)
      'z-index:99998',
      'background:rgba(20,25,35,.75)',
      'color:#8899aa',
      'font:10px ui-monospace,SFMono-Regular,Menlo,monospace',
      'padding:3px 9px',
      'border-radius:12px',
      'border:1px solid rgba(255,255,255,.06)',
      'user-select:none',
      'pointer-events:none',
      'transition:all .2s ease',
      'white-space:nowrap',
      'max-width:220px',
      'overflow:hidden',
      'text-overflow:ellipsis'
    ].join(';');
    if(!document.getElementById('hoc-sync-status-print-style')){
      var st = document.createElement('style');
      st.id = 'hoc-sync-status-print-style';
      st.textContent = '@media print { #hoc-sync-status { display: none !important; } }';
      document.head && document.head.appendChild(st);
    }
    document.body.appendChild(_statusEl);
    return _statusEl;
  }

  function setStatus(state, changeCount){
    if(!_statusEl) createStatusEl();
    if(!_statusEl) return;
    if(state === 'pushing'){
      _statusEl.textContent = '↑ syncing…';
      _statusEl.style.background = 'rgba(59,130,246,.85)';
      _statusEl.style.color = '#e0eaff';
      _statusEl.style.pointerEvents = 'none';
      _statusEl.style.cursor = 'default';
      _statusEl.onclick = null;
    } else if(state === 'synced'){
      if(changeCount){
        // Persistent + clickable — operator taps when ready to see new data
        _statusEl.textContent = '↓ ' + changeCount + ' new · tap to refresh';
        _statusEl.style.background = 'rgba(76,175,80,.95)';
        _statusEl.style.color = '#0a2a10';
        _statusEl.style.pointerEvents = 'auto';
        _statusEl.style.cursor = 'pointer';
        _statusEl.title = changeCount + ' data update' + (changeCount>1?'s':'') + ' received from another device. Tap to refresh this view.';
        _statusEl.onclick = function(){
          // Also give dashboards a chance to hot-refresh without full reload
          try {
            if(typeof window.hocRefresh === 'function'){
              window.hocRefresh();
              _statusEl.textContent = '● synced';
              _statusEl.style.background = 'rgba(20,25,35,.75)';
              _statusEl.style.color = '#8899aa';
              _statusEl.style.pointerEvents = 'none';
              _statusEl.style.cursor = 'default';
              _statusEl.onclick = null;
              return;
            }
          } catch(e){}
          // Fallback: page reload
          location.reload();
        };
      } else {
        _statusEl.textContent = '● synced';
        _statusEl.style.background = 'rgba(20,25,35,.75)';
        _statusEl.style.color = '#8899aa';
        _statusEl.style.pointerEvents = 'none';
        _statusEl.style.cursor = 'default';
        _statusEl.onclick = null;
      }
    } else if(state === 'error'){
      _statusEl.textContent = '⚠ sync error';
      _statusEl.style.background = 'rgba(211,47,47,.85)';
      _statusEl.style.color = '#ffe5e5';
      _statusEl.style.pointerEvents = 'none';
      _statusEl.style.cursor = 'default';
      _statusEl.onclick = null;
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────
  function boot(){
    createStatusEl();
    setStatus('synced');
    pullApply(); // immediate pull on load
    if(pollHandle) return;
    pollHandle = setInterval(pullApply, POLL_MS);
  }

  if(document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  // ── Public API ───────────────────────────────────────────────────
  window.HocSync = {
    deviceId: deviceId,
    SYNC_KEYS: SYNC_KEYS,
    pullApply: pullApply,
    // Manual push (rare — usually setItem wrapper handles it)
    pushKey: function(k, v){
      if(SYNC_KEYS.indexOf(k) < 0) return;
      pushKey(k, typeof v === 'string' ? v : JSON.stringify(v));
    },
    // For debugging
    _lastAppliedByKey: function(){ return lastAppliedByKey; },
    _lastSeenServerTs: function(){ return lastSeenServerTs; }
  };
})();
