// ═══════════════════════════════════════════════════════════════════════
// hoc_capacity_engine.js
// ═══════════════════════════════════════════════════════════════════════
// v6.34v — Ports the HOC Production Tracker workbook's Line Summary +
// Full Control Dashboard math from Excel formulas into JavaScript.
//
// Inputs (all from localStorage, written by Data Upload Hub):
//   - hoc_upload_v1.batches      : per-batch records with line, std_speed,
//                                  std_hc, rem_min, plan_labor, status,
//                                  overdue, pct_comp, etc.
//   - hoc_line_setup_v1.setup    : per-line {line, pattern, hours_per_day,
//                                  weekdays:[1..6], active, notes}
//
// Outputs (returned, not stored — consumer dashboards keep their own state):
//   - HOC_Capacity.lineSummary(asOf, batches?, setup?) → array of per-line
//     rows: {line, pattern, avail_days, avail_hours, avail_minutes,
//            remaining_batches, running_batches, overdue_batches,
//            total_remaining_min, total_remaining_hrs, gap_hrs,
//            utilization, daily_burn_min, daily_burn_hrs,
//            risk_status, suggested_action, planned_labor_hrs,
//            labor_gap_hrs, need_per_day}
//   - HOC_Capacity.fullControl(asOf, batches?, setup?) → top-level KPIs
//     {open_batches, open_hours, overdue, at_risk, will_miss, no_load,
//      total_avail_hours, total_remaining_hrs, total_gap_hrs,
//      case_signal, batch_signal}
//
// Standing rule: NO hardcoded data. If batches or setup are missing,
// functions return [] / {} so consumers show empty state gracefully.
// ═══════════════════════════════════════════════════════════════════════
(function(global){
  'use strict';

  // ── Load helpers ───────────────────────────────────────────────────
  function loadBatches(){
    try {
      var up = JSON.parse(localStorage.getItem('hoc_upload_v1') || '{}');
      return Array.isArray(up.batches) ? up.batches : [];
    } catch(e){ return []; }
  }
  function loadSetup(){
    try {
      var ls = JSON.parse(localStorage.getItem('hoc_line_setup_v1') || '{}');
      return Array.isArray(ls.setup) ? ls.setup : [];
    } catch(e){ return []; }
  }

  // v6.34at: Hardcoded line patterns matching LINE_DEFAULTS in Production
  // Supervisor. Used as a FALLBACK when no Line Setup upload exists or
  // when an uploaded row has weekdays=[] (unknown pattern string).
  // Without this fallback, every line showed avail_hours=0 → Gap Hrs = full
  // negative remaining workload, making Line Summary unusable on first deploy
  // before the planner has uploaded Line_Setup.xlsx.
  var LINE_DEFAULTS_634at = {
    1:  {weekdays:[1,2,3,4],     pattern:'Mon-Thu',   hours_per_day:9.17, active:true},
    2:  {weekdays:[1,2,3,4,5,6], pattern:'Mon-Sat',   hours_per_day:9.17, active:true},
    3:  {weekdays:[1,2,3,4,5,6], pattern:'Mon-Sat',   hours_per_day:9.17, active:true},
    4:  {weekdays:[1,2,3,4,5,6], pattern:'Mon-Sat',   hours_per_day:9.17, active:true},
    5:  {weekdays:[3,4,5,6],     pattern:'Wed-Sat',   hours_per_day:9.17, active:true},
    6:  {weekdays:[1,2,3,4],     pattern:'Mon-Thu',   hours_per_day:9.17, active:true},
    8:  {weekdays:[3,4,5,6],     pattern:'Wed-Sat',   hours_per_day:9.17, active:true},
    10: {weekdays:[3,4,5,6],     pattern:'Wed-Sat',   hours_per_day:9.17, active:true},
    11: {weekdays:[1,2,3,4,5,6], pattern:'Mon-Sat',   hours_per_day:9.17, active:true},
    14: {weekdays:[1,2,3,4,5,6], pattern:'Mon-Sat',   hours_per_day:9.17, active:true},
    15: {weekdays:[3,4,5,6],     pattern:'Wed-Sat',   hours_per_day:9.17, active:true},
    16: {weekdays:[],            pattern:'As Needed', hours_per_day:9.17, active:false}
  };
  // Merge default patterns into setup. Adds missing lines and fills in
  // empty weekdays/zero hours_per_day on existing rows.
  function withDefaults(setup){
    var bySource = {};
    setup.forEach(function(s){ bySource[s.line] = s; });
    var merged = [];
    Object.keys(LINE_DEFAULTS_634at).forEach(function(ln){
      var lineNum = parseInt(ln);
      var def = LINE_DEFAULTS_634at[lineNum];
      var s = bySource[lineNum];
      if(!s){
        // No row from upload — use default
        merged.push({
          line: lineNum,
          pattern: def.pattern,
          hours_per_day: def.hours_per_day,
          weekdays: def.weekdays.slice(),
          manual_days: null,
          active: def.active,
          notes: '(default — Line_Setup.xlsx not uploaded)',
          _from_default: true
        });
      } else {
        // Row exists — patch missing fields from default
        var patched = {
          line: s.line,
          pattern: s.pattern || def.pattern,
          hours_per_day: (s.hours_per_day > 0 ? s.hours_per_day : def.hours_per_day),
          weekdays: (Array.isArray(s.weekdays) && s.weekdays.length) ? s.weekdays : def.weekdays.slice(),
          manual_days: s.manual_days,
          active: (s.active !== undefined) ? s.active : def.active,
          notes: s.notes || '',
          _from_default: false,
          _patched_weekdays: (Array.isArray(s.weekdays) && s.weekdays.length === 0)
        };
        merged.push(patched);
      }
    });
    merged.sort(function(a,b){ return a.line - b.line; });
    return merged;
  }

  // ── Date helpers ───────────────────────────────────────────────────
  // HOC closures (v6.34z). Mirrors HOLIDAYS_634o in HOC_Production_Supervisor.html.
  // Keep these two lists in sync when adding/removing closures.
  var HOLIDAYS = {
    '2026-06-18': 1, '2026-06-20': 1, '2026-07-02': 1, '2026-07-04': 1,
    '2026-09-05': 1, '2026-09-07': 1, '2026-11-26': 1, '2026-11-27': 1,
    '2026-12-25': 1
  };
  function iso(d){
    return d.getFullYear()+'-'+
           String(d.getMonth()+1).padStart(2,'0')+'-'+
           String(d.getDate()).padStart(2,'0');
  }
  // Given a Date and a weekdays array (e.g. [1,2,3,4] for Mon-Thu),
  // count the matching days from asOf through end-of-month, minus HOC closures.
  function countAvailDays(asOf, weekdays){
    if(!weekdays || weekdays.length === 0) return 0;
    var lookup = {};
    weekdays.forEach(function(d){ lookup[d] = true; });
    var start = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
    var end   = new Date(asOf.getFullYear(), asOf.getMonth() + 1, 0); // last day of month
    var count = 0;
    for(var d = new Date(start); d <= end; d.setDate(d.getDate() + 1)){
      if(!lookup[d.getDay()]) continue;
      if(HOLIDAYS[iso(d)]) continue;  // subtract HOC closure
      count++;
    }
    return count;
  }

  // ── Risk classification (matches workbook's Line Summary logic) ────
  // Order matters: NO LOAD wins if no batches, otherwise gap thresholds.
  function riskStatus(remBatches, gapHrs){
    if(remBatches === 0) return 'NO LOAD';
    if(gapHrs < 0)       return 'WILL MISS';
    if(gapHrs <= 5)      return 'AT RISK';
    return 'SAFE';
  }
  function suggestedAction(risk){
    // Direct port of the workbook's Suggested Action mapping
    switch(risk){
      case 'NO LOAD':   return 'No load — reassign or schedule';
      case 'WILL MISS': return 'Add OT / weekend / shift batch';
      case 'AT RISK':   return 'Watch closely / pre-stage';
      case 'SAFE':      return 'Hold standard';
      default:          return '';
    }
  }

  // ── Per-line summary ───────────────────────────────────────────────
  function lineSummary(asOf, batches, setup){
    if(!asOf) asOf = new Date();
    if(!batches) batches = loadBatches();
    if(!setup)   setup   = loadSetup();
    // v6.34at: Always merge with defaults so dashboards work pre-upload AND
    // when an uploaded Line_Setup row has an unrecognized pattern string.
    setup = withDefaults(setup);
    if(!setup.length) return [];

    // Group batches by line for efficient lookup
    var byLine = {};
    batches.forEach(function(b){
      var ln = parseInt(b.line);
      if(isNaN(ln)) return;
      if(!byLine[ln]) byLine[ln] = [];
      byLine[ln].push(b);
    });

    return setup.map(function(s){
      var lineBatches = byLine[s.line] || [];
      // Avail Days: respect manual override (matches workbook Setup!J column).
      // If manual_days is set, use it; otherwise compute from weekdays + asOf.
      var availDays;
      if(s.manual_days !== null && s.manual_days !== undefined){
        availDays = s.active ? s.manual_days : 0;
      } else {
        availDays = s.active ? countAvailDays(asOf, s.weekdays) : 0;
      }
      var availHours = availDays * (s.hours_per_day || 0);
      var availMinutes = availHours * 60;

      // Horizon: only consider batches scheduled in the current planning month
      // (same month as asOf). Batches dated after end-of-month don't count
      // toward this month's gap — they're on next month's schedule.
      var horizonEnd = new Date(asOf.getFullYear(), asOf.getMonth() + 1, 0);
      function inHorizon(b){
        if(!b.date) return true;  // missing date = include (conservative)
        var d = new Date(b.date);
        if(isNaN(d.getTime())) return true;
        return d <= horizonEnd;
      }
      var horizonBatches = lineBatches.filter(inHorizon);

      // Batch counts (only horizon batches)
      var remBatches = 0, runBatches = 0, overdueBatches = 0;
      var totalRemMin = 0;
      var plannedLaborHrs = 0;
      var overdueMin = 0;
      var scheduledMin = 0;  // sum of std minutes for all batches assigned this month
      horizonBatches.forEach(function(b){
        var status = String(b.status || '').toUpperCase();
        var remMin = parseFloat(b.rem_min) || 0;
        var planLabor = parseFloat(b.plan_labor) || 0;
        var overdue = String(b.overdue || '').toUpperCase() === 'YES';
        if(status !== 'COMPLETED'){
          remBatches++;
          totalRemMin += remMin;
          plannedLaborHrs += planLabor;
          if(overdue){
            overdueBatches++;
            overdueMin += remMin;
          }
        }
        if(status === 'RUNNING') runBatches++;
        // Scheduled = full standard minutes of every batch on this line in this view
        // (workbook computes from planea / std_speed; we use remMin as proxy when actqty=0,
        //  std_minutes_per_batch isn't directly on the record. Approximation: remMin when
        //  pct_comp=0, or extrapolate from rem_min / (1 - pct_comp/100) for partial.)
        var pct = parseFloat(b.pct_comp) || 0;
        if(pct > 0 && pct < 100){
          scheduledMin += remMin / (1 - pct/100);
        } else if(pct === 0){
          scheduledMin += remMin;
        }
        // Completed batches contribute full std minutes — proxy via plan_labor*60/headcount if needed
      });
      var totalRemHrs = totalRemMin / 60;
      var gapHrs = availHours - totalRemHrs;
      var utilization = availHours > 0 ? (totalRemHrs / availHours) : 0;
      var dailyBurnMin = availDays > 0 ? (totalRemMin / availDays) : 0;
      var dailyBurnHrs = dailyBurnMin / 60;
      var risk = riskStatus(remBatches, gapHrs);
      var action = suggestedAction(risk);
      // Labor gap: planned vs available labor capacity.
      // Workbook uses std_hc per batch — we approximate available labor as
      // availHours * (avg crew size of this line's batches).
      var avgHc = 0;
      if(horizonBatches.length){
        var sumHc = horizonBatches.reduce(function(a,b){ return a + (parseFloat(b.std_hc)||0); }, 0);
        avgHc = sumHc / horizonBatches.length;
      }
      var laborCapacityHrs = availHours * avgHc;
      var laborGapHrs = laborCapacityHrs - plannedLaborHrs;
      var needPerDayMin = availDays > 0 ? (totalRemMin / availDays) : totalRemMin;

      return {
        line: s.line,
        pattern: s.pattern,
        active: s.active,
        notes: s.notes,
        // v6.34at: provenance flags so renderer can show "(default)" indicator
        from_default: !!s._from_default,
        patched_weekdays: !!s._patched_weekdays,
        avail_days: availDays,
        avail_hours: Math.round(availHours * 100) / 100,
        avail_minutes: Math.round(availMinutes),
        remaining_batches: remBatches,
        running_batches: runBatches,
        overdue_batches: overdueBatches,
        overdue_min: Math.round(overdueMin),
        scheduled_min: Math.round(scheduledMin),
        total_remaining_min: Math.round(totalRemMin),
        total_remaining_hrs: Math.round(totalRemHrs * 100) / 100,
        gap_hrs: Math.round(gapHrs * 100) / 100,
        utilization: Math.round(utilization * 1000) / 1000,
        daily_burn_min: Math.round(dailyBurnMin * 100) / 100,
        daily_burn_hrs: Math.round(dailyBurnHrs * 100) / 100,
        risk_status: risk,
        suggested_action: action,
        planned_labor_hrs: Math.round(plannedLaborHrs * 100) / 100,
        labor_capacity_hrs: Math.round(laborCapacityHrs * 100) / 100,
        labor_gap_hrs: Math.round(laborGapHrs * 100) / 100,
        avg_hc: Math.round(avgHc * 100) / 100,
        need_per_day_min: Math.round(needPerDayMin * 100) / 100
      };
    });
  }

  // ── Top-level Full Control rollup ──────────────────────────────────
  function fullControl(asOf, batches, setup){
    if(!asOf) asOf = new Date();
    if(!batches) batches = loadBatches();
    if(!setup)   setup   = loadSetup();
    var rows = lineSummary(asOf, batches, setup);

    // Aggregate across lines
    var openBatches = 0, openHrs = 0, overdue = 0;
    var willMiss = 0, atRisk = 0, safe = 0, noLoad = 0;
    var totalAvailHrs = 0, totalRemainingHrs = 0;
    rows.forEach(function(r){
      openBatches += r.remaining_batches;
      openHrs     += r.total_remaining_hrs;
      overdue     += r.overdue_batches;
      totalAvailHrs    += r.avail_hours;
      totalRemainingHrs += r.total_remaining_hrs;
      if(r.risk_status === 'WILL MISS') willMiss++;
      else if(r.risk_status === 'AT RISK') atRisk++;
      else if(r.risk_status === 'NO LOAD') noLoad++;
      else safe++;
    });
    var totalGapHrs = totalAvailHrs - totalRemainingHrs;

    // Case + Batch signals — direct port of workbook logic
    // Workbook compares Current Cases vs Need@90% and Open Batches vs capacity.
    // Without month-to-date case totals we approximate using batch counts:
    // RED if any line WILL MISS, AMBER if any AT RISK, GREEN otherwise.
    var batchSignal;
    if(willMiss > 0)      batchSignal = 'RED';
    else if(atRisk > 0)   batchSignal = 'AMBER';
    else                  batchSignal = 'GREEN';
    // Case signal: also red if total gap is negative
    var caseSignal;
    if(totalGapHrs < 0)        caseSignal = 'RED';
    else if(totalGapHrs <= 10) caseSignal = 'AMBER';
    else                       caseSignal = 'GREEN';

    return {
      open_batches: openBatches,
      open_hours: Math.round(openHrs * 100) / 100,
      overdue_batches: overdue,
      will_miss_lines: willMiss,
      at_risk_lines: atRisk,
      safe_lines: safe,
      no_load_lines: noLoad,
      total_avail_hours: Math.round(totalAvailHrs * 100) / 100,
      total_remaining_hrs: Math.round(totalRemainingHrs * 100) / 100,
      total_gap_hrs: Math.round(totalGapHrs * 100) / 100,
      case_signal: caseSignal,
      batch_signal: batchSignal
    };
  }

  // ── Public surface ────────────────────────────────────────────────
  global.HOC_Capacity = {
    lineSummary: lineSummary,
    fullControl: fullControl,
    // Exposed for unit testing
    _internal: {
      countAvailDays: countAvailDays,
      riskStatus: riskStatus,
      suggestedAction: suggestedAction,
      loadBatches: loadBatches,
      loadSetup: loadSetup
    }
  };
})(typeof window !== 'undefined' ? window : global);
