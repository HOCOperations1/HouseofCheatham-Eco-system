// ═══════════════════════════════════════════════════════════════════════
// hoc_floor.js  ·  v6.34ag
// ═══════════════════════════════════════════════════════════════════════
// Per-batch LIVE state — separate from uploaded plan data.
//
// `hoc_upload_v1` holds the planned batch list (what should happen).
// This library handles the floor's mutations: what actually happened.
// Stored two places:
//   - Supabase `hoc_batches` table   — durable, cross-device source of truth
//   - localStorage `hoc_floor_v1`    — same shape, offline-tolerant cache
// On read, we merge: Supabase if reachable, fall back to local.
// On write, we update BOTH (local immediately, Supabase best-effort).
//
// State per batch (string fields, all optional):
//   mix_complete: true/false      // operator marked mixing done
//   mix_complete_at: ISO timestamp
//   mix_complete_by: operator id/name (optional, may be null)
//   qc_status: 'QUEUED' | 'RELEASED' | 'HOLD' | 'REWORK' | null
//   qc_hold_reason: string (when HOLD/REWORK)
//   qc_status_at: ISO timestamp
//
// Key: batch number string (must match `batch` field in hoc_upload_v1.batches).
//
// API:
//   HOC_Floor.getState(batchId)   → state object or null
//   HOC_Floor.getAll()            → { batchId: state, ... }
//   HOC_Floor.update(batchId, patch) → Promise (writes both layers)
//   HOC_Floor.refresh()           → Promise (pulls Supabase → local cache)
//   HOC_Floor.onChange(callback)  → subscribe to local cache changes
//
// Defensive design: if Supabase rejects (missing columns, network failure,
// auth), the local write still succeeds, and we log a warning. The UI
// stays functional. To go fully durable, add the columns in Supabase:
//
//   alter table hoc_batches add column if not exists mix_complete boolean default false;
//   alter table hoc_batches add column if not exists mix_complete_at timestamptz;
//   alter table hoc_batches add column if not exists mix_complete_by text;
//   alter table hoc_batches add column if not exists qc_status text;
//   alter table hoc_batches add column if not exists qc_hold_reason text;
//   alter table hoc_batches add column if not exists qc_status_at timestamptz;
// ═══════════════════════════════════════════════════════════════════════
(function(global){
  'use strict';
  if(global.HOC_Floor) return;  // load-once guard

  var SUPA_URL = 'https://yemtpvrumqvbzrzpwnyy.supabase.co';
  var SUPA_KEY = 'sb_publishable_YrMf3_sGly4dir1cEGErfg_SSusnfJl';
  var STORAGE_KEY = 'hoc_floor_v1';
  var H = function(){ return {
    'apikey': SUPA_KEY,
    'Authorization': 'Bearer ' + SUPA_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };};

  var listeners = [];

  function loadCache(){
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch(e){ return {}; }
  }

  function saveCache(map){
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch(e){
      console.warn('[HOC_Floor] saveCache failed:', e);
    }
    // Fire listeners (sync, in-tab)
    listeners.forEach(function(fn){
      try { fn(map); } catch(e){ console.warn('[HOC_Floor] listener error:', e); }
    });
  }

  function getState(batchId){
    if(!batchId) return null;
    var map = loadCache();
    return map[batchId] || null;
  }

  function getAll(){
    return loadCache();
  }

  // Merge a partial patch into a batch's state, write both layers.
  function update(batchId, patch){
    if(!batchId){
      return Promise.reject(new Error('batchId is required'));
    }
    patch = patch || {};
    // 1. Update local cache immediately
    var map = loadCache();
    var prev = map[batchId] || {};
    var next = Object.assign({}, prev, patch, { _updated_at: new Date().toISOString() });
    map[batchId] = next;
    saveCache(map);

    // 2. Best-effort Supabase write. We use UPSERT semantics by trying PATCH
    //    on the row first; if 0 rows match, POST a new one.
    if(typeof fetch === 'undefined') return Promise.resolve(next);
    var supaPayload = Object.assign({ batch_id: batchId }, patch);
    // Strip _updated_at — Supabase tracks its own
    delete supaPayload._updated_at;

    return fetch(SUPA_URL + '/rest/v1/hoc_batches?batch_id=eq.' + encodeURIComponent(batchId), {
      method: 'PATCH',
      headers: H(),
      body: JSON.stringify(supaPayload)
    }).then(function(r){
      if(r.status === 204 || r.ok){
        // PATCH may return 200 with body or 204 no content. Either way we got through.
        return r.text().then(function(txt){
          if(txt && txt.startsWith('[]')){
            // No row matched — insert
            return fetch(SUPA_URL + '/rest/v1/hoc_batches', {
              method: 'POST',
              headers: H(),
              body: JSON.stringify(supaPayload)
            });
          }
          return r;
        }).catch(function(){ return r; });
      }
      console.warn('[HOC_Floor] Supabase PATCH non-OK:', r.status);
      return r;
    }).catch(function(err){
      console.warn('[HOC_Floor] Supabase write failed (local still saved):', err);
      return null;
    }).then(function(){ return next; });
  }

  // Pull all rows from Supabase into the local cache.
  function refresh(){
    if(typeof fetch === 'undefined') return Promise.resolve(loadCache());
    return fetch(SUPA_URL + '/rest/v1/hoc_batches?select=*', { headers: H() })
      .then(function(r){
        if(!r.ok){
          console.warn('[HOC_Floor] refresh non-OK:', r.status);
          return loadCache();
        }
        return r.json().then(function(rows){
          var map = {};
          (rows || []).forEach(function(row){
            if(!row.batch_id) return;
            // Legacy schema: Quality Lab writes a `data` JSON blob with the
            // QC fields inside. New schema: flat columns on hoc_batches.
            // Merge both so existing Quality Lab writes continue to work.
            var dataBlob = {};
            if(row.data){
              try {
                dataBlob = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
              } catch(e){ dataBlob = {}; }
            }
            map[row.batch_id] = {
              mix_complete:     row.mix_complete    || dataBlob.mix_complete    || false,
              mix_complete_at:  row.mix_complete_at || dataBlob.mix_complete_at || null,
              mix_complete_by:  row.mix_complete_by || dataBlob.mix_complete_by || null,
              qc_status:        row.qc_status       || dataBlob.qc_status       || null,
              qc_hold_reason:   row.qc_hold_reason  || dataBlob.qc_hold_reason  || dataBlob.qc_reject_reason || null,
              qc_status_at:     row.qc_status_at    || dataBlob.qc_tested_at    || null,
              _updated_at:      row.updated_at      || row.created_at           || null
            };
          });
          // Merge with any local-only writes that haven't synced yet
          var local = loadCache();
          Object.keys(local).forEach(function(k){
            if(!map[k]) map[k] = local[k];
          });
          saveCache(map);
          return map;
        });
      })
      .catch(function(err){
        console.warn('[HOC_Floor] refresh failed (using cache):', err);
        return loadCache();
      });
  }

  // Subscribe to in-tab cache changes (saveCache triggers these).
  // Returns an unsubscribe function.
  function onChange(fn){
    if(typeof fn !== 'function') return function(){};
    listeners.push(fn);
    return function(){
      var i = listeners.indexOf(fn);
      if(i >= 0) listeners.splice(i, 1);
    };
  }

  // Cross-tab sync via storage event
  global.addEventListener && global.addEventListener('storage', function(e){
    if(e.key === STORAGE_KEY){
      listeners.forEach(function(fn){
        try { fn(loadCache()); } catch(err){}
      });
    }
  });

  // Auto-refresh on load — best-effort pull from Supabase.
  // Failures don't block; local cache is already usable.
  setTimeout(function(){
    refresh();
  }, 500);
  // And periodically (every 30s) so multi-tablet floor stays in sync.
  setInterval(function(){
    refresh();
  }, 30000);

  global.HOC_Floor = {
    getState:  getState,
    getAll:    getAll,
    update:    update,
    refresh:   refresh,
    onChange:  onChange,
    _internal: { STORAGE_KEY: STORAGE_KEY }
  };
})(typeof window !== 'undefined' ? window : globalThis);
