// ═══════════════════════════════════════════════════════════════════════
//  HOC-OES — Vicinity 4 OData Datalink
//  Connects HOC-OES tablets to Vicinity 4 via OData REST endpoints.
//
//  Architecture:
//    Vicinity OData (hoc-dts-svr-025:5555)
//       ↓ HTTPS/HTTP fetch with credentials
//    vicinity_datalink.js (this file, runs in browser)
//       ↓ field mapping + dedup
//    localStorage.hoc_upload_v1 + Supabase hoc_sync_bus
//       ↓ existing sync infrastructure
//    Every HOC-OES dashboard (no changes needed)
//
//  Loaded by: Data Upload Hub (primary), can be loaded anywhere.
//  Storage:   hoc_vicinity_v1  — last-pull metadata + raw cache
//             hoc_upload_v1    — same structure as paste-derived data
//
//  Server is internal (port 5555), so the browser running this script must
//  be on the same network. If not, fetches fail silently and we fall back
//  to whatever's already in localStorage / Supabase sync bus.
// ═══════════════════════════════════════════════════════════════════════

(function(global){
  'use strict';

  // ── Endpoint configuration ──────────────────────────────────────────
  // Server discovered from Vicinity 4 OData dialog. Internal hostname.
  // Override via localStorage('hoc_vicinity_base_url') if it changes.
  const DEFAULT_BASE = 'http://hoc-dts-svr-025:5555/VicinityWeb/odata/HOCVIC';
  function getBaseUrl(){
    try {
      var override = localStorage.getItem('hoc_vicinity_base_url');
      return (override && override.trim()) || DEFAULT_BASE;
    } catch(e){ return DEFAULT_BASE; }
  }

  // The 32 endpoints identified from your view library. Each entry:
  //   key:        short canonical name used in HOC-OES code
  //   view:       URL-encoded OData view name
  //   tier:       1-5, build priority
  //   purpose:    human description
  //   tx:         transform function (raw row → HOC-OES record), or null
  const VIEWS = {
    // ── TIER 1 ── replaces manual paste paths ─────────────────────────
    production_schedule: {
      view:    'vv_Planning_Production%20Schedule',
      tier:    1,
      purpose: 'Master production schedule (every dashboard depends on this)',
      tx:      txProductionSchedule
    },
    open_batches_volumes: {
      view:    'vv_Custom%20Views_Production%20Control_Open_Batches%20with%20Volumes',
      tier:    1,
      purpose: 'Currently running batches with actual qty',
      tx:      null  // raw passthrough until field mapping confirmed
    },
    open_batches: {
      view:    'vv_Production%20Control_Open_Batches',
      tier:    1,
      purpose: 'Open batch headers + status',
      tx:      null
    },
    ops_closed_batches: {
      view:    'vv_Production%20Control_Ops%20Closed_Batches',
      tier:    1,
      purpose: 'Completed operations (case attainment math)',
      tx:      null
    },
    patch_oee_jobs: {
      view:    'vv_Custom%20Views_Patch%20OEE_Production%20Jobs',
      tier:    1,
      purpose: 'Direct Patch OEE feed (replaces CSV upload)',
      tx:      null
    },
    batch_production_fg: {
      view:    'vv_Production%20Control_Open_Batch%20Production%20FG',
      tier:    1,
      purpose: 'Cases per batch (planned + actual FG)',
      tx:      null
    },

    // ── TIER 2 ── major upgrades ──────────────────────────────────────
    components_master: {
      view:    'vv_Custom%20Views_Components_Components',
      tier:    2,
      purpose: 'BOM component master'
    },
    component_composition: {
      view:    'vv_Custom%20Views_Component%20Composition',
      tier:    2,
      purpose: 'Detailed BOM lines per batch'
    },
    component_std_runtime: {
      view:    'vv_Custom%20Views_Component%20Std%20Runtime',
      tier:    2,
      purpose: 'Labor standards (replaces Aug 2025 extract)',
      tx:      txComponentStdRuntime
    },
    component_std_setup: {
      view:    'vv_Custom%20Views_Component%20Std%20Setup',
      tier:    2,
      purpose: 'Setup time per component'
    },
    available_to_make: {
      view:    'vv_Custom%20Views_Available%20to%20Make',
      tier:    2,
      purpose: 'What can be produced from on-hand inventory'
    },
    theoretical_vs_actual: {
      view:    'vv_Custom%20Views_Batches_Theoretical%20vs%20Actual',
      tier:    2,
      purpose: 'Yield/giveaway analysis'
    },
    batch_parameters: {
      view:    'vv_Production%20Control_Open_Batch%20Parameters',
      tier:    2,
      purpose: 'Run parameters per batch'
    },
    batch_packaging: {
      view:    'vv_Production%20Control_Open_Batch%20Packaging',
      tier:    2,
      purpose: 'Packaging info per batch'
    },
    batch_procedures: {
      view:    'vv_Production%20Control_Open_Batch%20Procedures',
      tier:    2,
      purpose: 'SOPs / steps per batch'
    },

    // ── TIER 3 ── Planning & MRP ──────────────────────────────────────
    forecasts: {
      view:    'vv_Planning_Forecasts',
      tier:    3,
      purpose: 'Demand forecasts'
    },
    mrp_requirements: {
      view:    'vv_Planning_MRP%20Requirements',
      tier:    3,
      purpose: 'What needs to be produced/bought'
    },
    mrp_detail: {
      view:    'vv_Custom%20Views_Planning_MRP%20Detail',
      tier:    3,
      purpose: 'MRP detail breakdown'
    },
    planned_pos: {
      view:    'vv_Planning_Planned%20Orders%20-%20Purchase%20Orders',
      tier:    3,
      purpose: 'POs about to be cut'
    },

    // ── TIER 4 ── Quality ─────────────────────────────────────────────
    qc_v2_results: {
      view:    'vv_Custom%20Views_V2%20Batch%20Quality%20Results',
      tier:    4,
      purpose: 'Quality Lab QC results'
    },
    qc_end_item: {
      view:    'vv_Quality%20Control_Batch%20End-Item%20QC%20Results',
      tier:    4,
      purpose: 'Final batch release status'
    },
    qc_batch_samples: {
      view:    'vv_Quality%20Samples_Batch%20Samples',
      tier:    4,
      purpose: 'Sample-level QC'
    },
    qc_samples_summary: {
      view:    'vv_Custom%20Views_Quality%20Samples_Batch%20Samples%20Summary',
      tier:    4,
      purpose: 'QC rollup'
    },
    batches_missing_bac: {
      view:    'vv_Custom%20Views_Batches%20Missing%20BAC%20Records',
      tier:    4,
      purpose: 'Data quality canary'
    },

    // ── TIER 5 ── Master data (formulas, components) ──────────────────
    formulas_master: {
      view:    'vv_Product%20Development_Formulas_Formulas',
      tier:    5,
      purpose: 'Master formula library'
    },
    mix_formulas: {
      view:    'vv_Product%20Development_Formulas_Mix_Mix%20Formulas',
      tier:    5,
      purpose: 'Mix-stage formulas'
    },
    product_components: {
      view:    'vv_Product%20Development_Components_Components',
      tier:    5,
      purpose: 'Master component catalog'
    },
    product_attributes: {
      view:    'vv_Product%20Development_Attributes',
      tier:    5,
      purpose: 'Formula attributes'
    },
    product_additional_costs: {
      view:    'vv_Product%20Development_Additional%20Costs',
      tier:    5,
      purpose: 'Cost rollup'
    },
    change_log_uom: {
      view:    'vv_Product%20Development_Change%20Logs_UOM%20Change%20Utility',
      tier:    5,
      purpose: 'UOM change audit'
    },
    change_log_component: {
      view:    'vv_Product%20Development_Change%20Logs_Component%20ID%20Change%20Utility',
      tier:    5,
      purpose: 'Component ID change audit'
    },
    change_log_bom: {
      view:    'vv_Product%20Development_Change%20Logs_Bill%20of%20Material%20Mass%20Component%20Maintenance',
      tier:    5,
      purpose: 'BOM change history'
    }
  };

  // ── Supabase config (mirrors other modules) ──────────────────────────
  const SUPA_URL = 'https://yemtpvrumqvbzrzpwnyy.supabase.co';
  const SUPA_KEY = 'sb_publishable_YrMf3_sGly4dir1cEGErfg_SSusnfJl';
  const HDR  = () => ({apikey:SUPA_KEY, Authorization:'Bearer '+SUPA_KEY});
  const HDRJ = () => ({apikey:SUPA_KEY, Authorization:'Bearer '+SUPA_KEY,'Content-Type':'application/json'});

  // ── Metadata storage ────────────────────────────────────────────────
  const LS_META = 'hoc_vicinity_v1';
  function loadMeta(){ try { return JSON.parse(localStorage.getItem(LS_META) || '{}'); } catch(e){ return {}; } }
  function saveMeta(m){ try { localStorage.setItem(LS_META, JSON.stringify(m)); } catch(e){} }

  // ── Core fetch with timeout + credentials passthrough ───────────────
  // credentials:'include' lets Windows Auth pass through if Vicinity needs it
  // (Edge/Chrome on a domain-joined machine will forward Kerberos/NTLM).
  // If browser is NOT domain-joined, this becomes anonymous — works if the
  // OData endpoint allows anonymous reads (which the user's tests confirmed).
  async function rawFetch(endpointKey, opts){
    opts = opts || {};
    const cfg = VIEWS[endpointKey];
    if(!cfg) throw new Error('Unknown endpoint: '+endpointKey);
    const base = getBaseUrl();
    var url = base + '/' + cfg.view;
    // OData query params: $filter, $top, $select, $orderby
    const params = [];
    if(opts.top)     params.push('$top=' + encodeURIComponent(opts.top));
    if(opts.filter)  params.push('$filter=' + encodeURIComponent(opts.filter));
    if(opts.select)  params.push('$select=' + encodeURIComponent(opts.select));
    if(opts.orderby) params.push('$orderby=' + encodeURIComponent(opts.orderby));
    if(params.length) url += '?' + params.join('&');

    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), opts.timeout || 8000);
    try {
      const r = await fetch(url, {
        method: 'GET',
        credentials: 'include',  // forward Windows Auth if endpoint requires it
        headers: { 'Accept': 'application/json' },
        signal: ctrl.signal
      });
      clearTimeout(timeoutId);
      if(!r.ok){
        throw new Error('HTTP ' + r.status + ' from ' + cfg.view);
      }
      const data = await r.json();
      return data.value || data;  // OData v4 wraps in {value: [...]}
    } catch(err){
      clearTimeout(timeoutId);
      throw err;
    }
  }

  // ── Field mapping: Vicinity → HOC-OES ──────────────────────────────
  // Confirmed from user's screenshot of vv_Planning_Production Schedule.
  // Fields seen: ComponentID, Description, Source, DocumentNumber,
  //              BatchDescription, FormulaID, StartDate, DueDate,
  //              Quantity, UOM, Status, FacilityId, Notes
  function txProductionSchedule(row){
    // Defensive: every field is optional in case Vicinity returns nulls
    const main = row.DocumentNumber || '';
    const desc = row.Description || row.BatchDescription || '';
    // Line number isn't in Schedule view directly. FacilityId is "MAIN" for
    // all rows in the sample — actual line comes from Open_Batches view.
    // For now we default to 1 and let join overlay overwrite later.
    return {
      main:      main,
      item:      row.ComponentID || '',
      desc:      desc,
      date:      iso10(row.StartDate),
      cmpddue:   iso10(row.DueDate),
      line:      0,  // populated later by join with Open_Batches
      origqty:   Number(row.Quantity) || 0,
      actqty:    0,  // populated by Ops_Closed
      minutes:   0,
      casepk:    inferCasePk(row.ComponentID),
      planea:    0,  // computed downstream
      status:    mapStatus(row.Status),
      cmpd:      '',
      risk:      '',
      shortage:  0,
      formula:   row.FormulaID ? parseInt(row.FormulaID) : null,
      fname:     '',
      pb_hrs:    3.0,  // default until labor extract merge
      pb_start:  '',
      cy:        0,
      qc_h:      0,
      lbs:       0,
      // raw passthrough fields preserved for debugging
      _src:      'vicinity:production_schedule',
      _uom:      row.UOM,
      _facility: row.FacilityId,
      _source:   row.Source,
      _notes:    row.Notes
    };
  }

  function txComponentStdRuntime(row){
    // Confirmed field names from the existing labor extract parser pattern.
    // We expect: ComponentID/FormulaID, LaborID, LaborTime, TimeType.
    // Vicinity OData may surface them under slightly different names —
    // adjust here once we see actual response.
    return {
      formula_id: row.FormulaID || row.ComponentID || '',
      labor_id:   row.LaborID || row.Labor_ID || '',
      labor_time: Number(row.LaborTime || row.Labor_Time || 0),
      time_type:  row.TimeType || row.Time_Type || '',
      version:    row.Version || row.VersionNumber || null,
      description: row.Description || ''
    };
  }

  // ── Status mapping ──────────────────────────────────────────────────
  function mapStatus(vicinityStatus){
    if(!vicinityStatus) return 'NOT STARTED';
    const s = String(vicinityStatus).toUpperCase();
    if(s === 'RELEASED')   return 'NOT STARTED';
    if(s === 'IN PROCESS') return 'RUNNING';
    if(s === 'CLOSED')     return 'COMPLETED';
    if(s === 'CANCELLED' || s === 'CANCELED') return 'CANCELLED';
    return s;
  }

  // ── Utility: ISO date trim ───────────────────────────────────────────
  function iso10(v){
    if(!v) return '';
    var s = String(v);
    return s.slice(0,10);
  }

  // ── Utility: case pack inference (matches existing logic) ───────────
  function inferCasePk(itemCode){
    if(!itemCode) return 12;
    // Codes like 1-102-12-1243-01 → casepk in 3rd-from-right or
    // 4th-from-right position depending on bundle suffix.
    var parts = String(itemCode).split('-');
    if(parts.length >= 3){
      var maybe = parseInt(parts[parts.length - 2]);
      if(maybe > 0 && maybe < 200) return maybe;
    }
    return 12;
  }

  // ── Public API ──────────────────────────────────────────────────────
  // pullEndpoint(key, opts): fetch + transform + cache one endpoint
  async function pullEndpoint(endpointKey, opts){
    opts = opts || {};
    const cfg = VIEWS[endpointKey];
    if(!cfg) throw new Error('Unknown endpoint: '+endpointKey);
    const meta = loadMeta();
    meta[endpointKey] = meta[endpointKey] || {};
    meta[endpointKey].attempt_at = new Date().toISOString();
    saveMeta(meta);

    try {
      var raw = await rawFetch(endpointKey, opts);
      if(!Array.isArray(raw)) raw = [];
      // Transform
      var records = cfg.tx ? raw.map(cfg.tx).filter(Boolean) : raw;
      // Cache
      meta[endpointKey].success_at  = new Date().toISOString();
      meta[endpointKey].record_count = records.length;
      meta[endpointKey].last_error   = null;
      saveMeta(meta);
      return {records: records, raw: raw, meta: meta[endpointKey]};
    } catch(err){
      meta[endpointKey].failure_at = new Date().toISOString();
      meta[endpointKey].last_error = String(err.message || err);
      saveMeta(meta);
      throw err;
    }
  }

  // pullProductionSchedule(): pull Production Schedule + merge into hoc_upload_v1
  // Filters by Status='Released' to skip stale historical batches.
  async function pullProductionSchedule(opts){
    opts = opts || {};
    const result = await pullEndpoint('production_schedule', {
      filter: opts.filter || "Status eq 'Released'",
      top:    opts.top    || 5000,
      timeout: opts.timeout || 10000
    });
    // Write to hoc_upload_v1 in the same shape paste-derived data uses
    var current = {};
    try { current = JSON.parse(localStorage.getItem('hoc_upload_v1') || '{}'); } catch(e){}
    current.batches = result.records;
    current._updated = new Date().toISOString();
    current._source  = 'vicinity:live';

    // v6.33 — LB-2 fix: compute MTD goals from per-batch sums so the cases KPIs
    // don't go stale when Vicinity becomes the live source. Without this, every
    // KPI screen falls back through the priority order to attainment paste or
    // batch sum, neither of which agrees with the planner's MTD summary.
    // Computed-from-batches isn't *exactly* the planner's rollup (which can be
    // manually adjusted), so we label the source clearly. If exact match is
    // ever required, Vicinity should also pull the MTD summary view.
    try {
      var _d = new Date();
      var _monthPrefix = _d.getFullYear() + '-' + String(_d.getMonth()+1).padStart(2,'0');
      var _seen = {};
      var _planTotal = 0, _actualTotal = 0;
      (result.records || []).forEach(function(b){
        if(!b || !b.batch || _seen[b.batch]) return;
        if(!b.date || String(b.date).indexOf(_monthPrefix) !== 0) return;
        _seen[b.batch] = 1;
        _planTotal   += Number(b.origqty) || 0;
        _actualTotal += Number(b.actqty)  || 0;
      });
      if(_planTotal > 0 || _actualTotal > 0){
        current.goals = current.goals || {};
        current.goals.may_actual = Math.round(_actualTotal);
        current.goals.may_goal   = Math.round(_planTotal);
        current.goals.may_bal    = Math.round(_planTotal - _actualTotal);
        current.goals_ts         = current._updated;
        current.goals_source     = 'vicinity:computed_from_batches';
      }
    } catch(e){ console.warn('[vicinity] goals compute failed:', e); }

    localStorage.setItem('hoc_upload_v1', JSON.stringify(current));
    // Push to Supabase sync_bus so other tablets pick it up
    pushToSyncBus({batches: result.records, source:'vicinity', ts:current._updated})
      .catch(function(){});  // best-effort
    return result;
  }

  // pullLaborStandards(): pull Component Std Runtime → hoc_labor_standards_v1
  // Replaces the manually-uploaded Fill Labor Extract XLSX.
  async function pullLaborStandards(opts){
    opts = opts || {};
    const result = await pullEndpoint('component_std_runtime', {
      top: opts.top || 5000,
      timeout: opts.timeout || 15000  // larger view, more time
    });
    // Build the same structure the XLSX parser produces:
    //   {standards: {formulaId: {comp_time, fill_time, time_type, description}}, _updated, stats}
    var standards = {};
    result.records.forEach(function(r){
      if(!r.formula_id) return;
      var fid = String(r.formula_id);
      if(!standards[fid]) standards[fid] = {};
      // Time Type from extract: "Hours/LB in" = comp, "Hours/LB Out" = fill, "Hours" = fixed
      var t = String(r.time_type || '').toLowerCase();
      if(t.indexOf('hours/lb in') >= 0 || t === 'in' || t.indexOf('hours/lb') >= 0 && t.indexOf('out') < 0){
        standards[fid].comp_time = r.labor_time;
      }
      if(t.indexOf('hours/lb out') >= 0 || t === 'out'){
        standards[fid].fill_time = r.labor_time;
      }
      if(t === 'hours'){
        standards[fid].fixed_hours = r.labor_time;
      }
      standards[fid].time_type   = standards[fid].time_type   || r.time_type;
      standards[fid].description = standards[fid].description || r.description;
    });
    var saved = {
      standards: standards,
      _updated:  new Date().toISOString(),
      _source:   'vicinity:live',
      stats:     {
        formulas: Object.keys(standards).length,
        rows:     result.records.length
      }
    };
    localStorage.setItem('hoc_labor_standards_v1', JSON.stringify(saved));
    return {records: result.records, saved: saved, meta: result.meta};
  }

  // pullPatchOEE(): pull Patch OEE data — feed Production Supervisor OEE tile
  async function pullPatchOEE(opts){
    opts = opts || {};
    const result = await pullEndpoint('patch_oee_jobs', {
      top: opts.top || 5000,
      timeout: opts.timeout || 10000
    });
    // Cache for inspection; downstream wiring TBD once we see actual fields
    var cache = {
      records:  result.records,
      _updated: new Date().toISOString(),
      _source:  'vicinity:live'
    };
    localStorage.setItem('hoc_patch_oee_v1', JSON.stringify(cache));
    return result;
  }

  // ── Sync bus integration ────────────────────────────────────────────
  async function pushToSyncBus(payload){
    try {
      const r = await fetch(SUPA_URL+'/rest/v1/hoc_sync_bus?id=eq.1&select=payload', {headers:HDR()});
      if(!r.ok) return;
      const rows = await r.json();
      const existing = (rows[0] && rows[0].payload) || {};
      existing.vicinity = payload;
      // Also mirror batches into existing path so dashboards reading sync_bus get them
      if(payload.batches){
        existing.upload = existing.upload || {};
        existing.upload.batches  = payload.batches;
        existing.upload._updated = payload.ts;
        existing.upload._source  = 'vicinity';
      }
      await fetch(SUPA_URL+'/rest/v1/hoc_sync_bus?id=eq.1', {
        method:'PATCH',
        headers: Object.assign({}, HDRJ(), {Prefer:'return=minimal'}),
        body: JSON.stringify({updated_at:new Date().toISOString(), payload:existing})
      });
    } catch(e){ /* best effort */ }
  }

  // ── Health probe — used by Data Upload Hub status indicator ─────────
  async function probe(){
    var t0 = Date.now();
    try {
      // Minimal query — just enough to verify connectivity
      await rawFetch('production_schedule', {top:1, timeout:4000});
      return {ok:true, latency_ms: Date.now() - t0};
    } catch(err){
      return {ok:false, latency_ms: Date.now() - t0, error: String(err.message || err)};
    }
  }

  // ── Auto-poll: continuously refreshes Tier 1 endpoints in background ─
  let _pollTimer = null;
  function startAutoPoll(intervalMs){
    intervalMs = intervalMs || 15 * 60 * 1000;  // 15 min default
    stopAutoPoll();
    async function tick(){
      try { await pullProductionSchedule(); } catch(e){}
      try { await pullLaborStandards(); }    catch(e){}
      try { await pullPatchOEE(); }          catch(e){}
    }
    tick();  // immediate first pull
    _pollTimer = setInterval(tick, intervalMs);
  }
  function stopAutoPoll(){
    if(_pollTimer){ clearInterval(_pollTimer); _pollTimer = null; }
  }

  // ── Expose ──────────────────────────────────────────────────────────
  global.VicinityDatalink = {
    VIEWS: VIEWS,
    getBaseUrl: getBaseUrl,
    setBaseUrl: function(url){
      try { localStorage.setItem('hoc_vicinity_base_url', String(url||'')); } catch(e){}
    },
    pull: pullEndpoint,
    pullProductionSchedule: pullProductionSchedule,
    pullLaborStandards:     pullLaborStandards,
    pullPatchOEE:           pullPatchOEE,
    probe:                  probe,
    startAutoPoll:          startAutoPoll,
    stopAutoPoll:           stopAutoPoll,
    loadMeta:               loadMeta,
    // Raw escape hatch for ad-hoc views
    rawFetch:               rawFetch
  };

})(typeof window !== 'undefined' ? window : globalThis);
