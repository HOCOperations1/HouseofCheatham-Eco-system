// ═══════════════════════════════════════════════════════════════════════
// hoc_attainment.js
// ═══════════════════════════════════════════════════════════════════════
// v6.34ab — Compute schedule attainment LIVE from uploaded batch data.
// No storage, no caching — every call re-derives from hoc_upload_v1.
//
// Formula:   actual_cases / planned_cases
//            (= sum of actqty / sum of origqty, batches where origqty > 0)
//
// Scope:     ALL batches in the uploaded production schedule.
// Per-line:  Only lines 1, 2, 3, 4, 5, 11 are tracked by name. Other
//            lines contribute to plant attainment but aren't reported
//            individually.
//
// Exposed as window.HOC_Attainment with:
//   plantAttainment(batches?)  → number (0-100) or null
//   lineAttainment(line, batches?) → number (0-100) or null
//   allLines(batches?)         → {1: number|null, 2: ..., ..., 11: ...}
//   worstLine(batches?)        → {line, value} or null
//   summary(batches?)          → consolidated bundle for renderers
// ═══════════════════════════════════════════════════════════════════════
(function(global){
  'use strict';

  var TRACKED_LINES = [1, 2, 3, 4, 5, 11];

  function loadBatches(){
    try {
      var up = JSON.parse(localStorage.getItem('hoc_upload_v1') || '{}');
      return Array.isArray(up.batches) ? up.batches : [];
    } catch(e){ return []; }
  }

  // Compute actual_cases / planned_cases × 100, rounded to 1 decimal.
  // Returns null if no batches with origqty > 0 (can't compute meaningfully).
  //
  // v6.34as fix: SKIP batches where actqty is null/undefined/empty rather
  // than counting them as 0 toward the actual numerator. A null actqty
  // means "we don't know what actually happened yet" — typically not-yet-
  // started or running batches. Counting them as 0 made attainment crater
  // to 0% whenever the upload's batch window included any future-dated
  // schedule rows. Now: attainment reflects only batches where we have
  // a real actual value to compare against.
  function compute(batches){
    var planned = 0, actual = 0;
    var count = 0;
    for(var i = 0; i < batches.length; i++){
      var b = batches[i];
      var orig = parseFloat(b.origqty) || 0;
      if(orig <= 0) continue;  // skip batches with no plan
      // v6.34as: skip if actqty is null/undefined/empty (unknown actual)
      if(b.actqty === null || b.actqty === undefined || b.actqty === ''){
        continue;
      }
      var act = parseFloat(b.actqty);
      if(isNaN(act)) continue;
      planned += orig;
      actual  += act;
      count++;
    }
    if(count === 0 || planned === 0) return null;
    return Math.round((actual / planned) * 1000) / 10;
  }

  function plantAttainment(batches){
    if(!batches) batches = loadBatches();
    return compute(batches);
  }

  function lineAttainment(line, batches){
    if(!batches) batches = loadBatches();
    var lineNum = parseInt(line);
    if(isNaN(lineNum)) return null;
    var filtered = batches.filter(function(b){
      return parseInt(b.line) === lineNum;
    });
    return compute(filtered);
  }

  function allLines(batches){
    if(!batches) batches = loadBatches();
    var out = {};
    TRACKED_LINES.forEach(function(ln){
      out[ln] = lineAttainment(ln, batches);
    });
    return out;
  }

  function worstLine(batches){
    if(!batches) batches = loadBatches();
    var lines = allLines(batches);
    var worst = null, worstVal = null;
    Object.keys(lines).forEach(function(ln){
      var v = lines[ln];
      if(v === null || v === undefined) return;
      if(worstVal === null || v < worstVal){ worstVal = v; worst = parseInt(ln); }
    });
    if(worst === null) return null;
    return { line: worst, value: worstVal };
  }

  // Single-call bundle for consumer renderers
  function summary(batches){
    if(!batches) batches = loadBatches();
    var plant = plantAttainment(batches);
    var lines = allLines(batches);
    var worst = worstLine(batches);
    var trackedCount = TRACKED_LINES.filter(function(l){ return lines[l] !== null; }).length;
    return {
      plant: plant,
      lines: lines,
      worst: worst,
      tracked_lines: TRACKED_LINES.slice(),
      tracked_count_with_data: trackedCount,
      batch_count: batches.length
    };
  }

  global.HOC_Attainment = {
    plantAttainment: plantAttainment,
    lineAttainment: lineAttainment,
    allLines: allLines,
    worstLine: worstLine,
    summary: summary,
    TRACKED_LINES: TRACKED_LINES.slice(),
    _internal: { compute: compute, loadBatches: loadBatches }
  };
})(typeof window !== 'undefined' ? window : global);
