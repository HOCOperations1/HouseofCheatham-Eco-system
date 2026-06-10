// ═══════════════════════════════════════════════════════════════════════
// hoc_goal_engine.js
// ═══════════════════════════════════════════════════════════════════════
// v6.34ae — Goal vs Capacity Engine
// Faithful port of the HOC Production Tracker workbook's "Goal vs
// Capacity Engine" sheet (rows 12-18). Scores 6 specific lines, classifies
// MUST RUN / SHOULD RUN / DEFER + LOCK / WATCH / FLEX, surfaces root cause,
// action required, and action timing.
//
// Workbook formulas (faithfully ported):
//   Priority Score (col O):
//     ROUND( MAX(0,-OEE_Gap)*100*0.3
//          + MAX(0,-Attain_Gap)*100*0.3
//          + Remaining_Batches*4
//          + Remaining_Hrs*0.2 , 1 )
//   Auto Priority Tier (col P):
//     ≥60 → MUST RUN
//     ≥35 → SHOULD RUN
//     else → DEFER IF NEEDED
//   Scheduler Lock (col Q):
//     MUST RUN → LOCK
//     SHOULD RUN → WATCH
//     else → FLEX
//   Combined Risk (col M):
//     IF(BatchRisk=WILL MISS OR OEE_Gap<0 OR Attain_Gap<0)  → RED
//     ELIF(BatchRisk=AT RISK OR OEE_Gap<0.05 OR Attain_Gap<0.05) → YELLOW
//     ELSE → GREEN
//
// Lines scored: 1, 2, 3, 4, 5, 11 — matches workbook rows 13-18.
// Other lines are NOT scored (consistent with workbook scope).
//
// Inputs (read live from localStorage, no caching):
//   hoc_patch_oee_v1   → per-line OEE actuals (fraction 0..1)
//   hoc_kpi_manual_v1  → oee_goal, att_goal (defaults 60, 90)
//   hoc_upload_v1      → batches (for Capacity engine + Attainment)
//   hoc_line_setup_v1  → patterns + active flag (for Capacity engine)
//
// Outputs:
//   scoreLines() → array of 6 row objects with all 21 workbook fields
// ═══════════════════════════════════════════════════════════════════════
(function(global){
  'use strict';

  // Scope: only these lines are scored. Matches workbook rows 13-18.
  var SCORED_LINES = [1, 2, 3, 4, 5, 11];

  function loadJSON(key){
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch(e){ return null; }
  }

  // ── Combined Risk classification (workbook col M) ────────────────────
  // Order matters — checks RED conditions first, then YELLOW, else GREEN.
  function combinedRisk(batchRisk, oeeGap, attainGap){
    if(batchRisk === 'WILL MISS' || oeeGap < 0 || attainGap < 0) return 'RED';
    if(batchRisk === 'AT RISK'   || oeeGap < 0.05 || attainGap < 0.05) return 'YELLOW';
    return 'GREEN';
  }

  // ── Priority Score (workbook col O) ──────────────────────────────────
  // Weights: OEE shortfall 30%, Attainment shortfall 30%, batches × 4,
  // hours × 0.2. Only negative gaps contribute (i.e., shortfalls only,
  // overperformance doesn't reduce priority).
  function priorityScore(oeeGap, attainGap, remBatches, remHrs){
    var s = Math.max(0, -oeeGap)    * 100 * 0.3
          + Math.max(0, -attainGap) * 100 * 0.3
          + remBatches * 4
          + remHrs * 0.2;
    return Math.round(s * 10) / 10;
  }

  // ── Auto Priority Tier (workbook col P) ──────────────────────────────
  function priorityTier(score){
    if(score >= 60) return 'MUST RUN';
    if(score >= 35) return 'SHOULD RUN';
    return 'DEFER IF NEEDED';
  }

  // ── Scheduler Lock (workbook col Q) ──────────────────────────────────
  function schedulerLock(tier){
    if(tier === 'MUST RUN')   return 'LOCK';
    if(tier === 'SHOULD RUN') return 'WATCH';
    return 'FLEX';
  }

  // ── Suggested Action (workbook col N) ────────────────────────────────
  // Decision tree based on Batch Risk + Combined Risk.
  function suggestedAction(batchRisk, combinedR){
    if(batchRisk === 'WILL MISS') return 'Immediate schedule/labor correction';
    if(batchRisk === 'AT RISK')   return 'Watch daily / protect schedule';
    if(combinedR === 'RED')       return 'Immediate schedule/labor correction';
    if(combinedR === 'YELLOW')    return 'Monitor and protect next best batches';
    return 'Hold standard';
  }

  // ── Primary Constraint (workbook col S) ──────────────────────────────
  // Identifies the root-cause constraint when Combined Risk isn't GREEN.
  // Note: workbook uses Case Balance (facility-level) at $B$6. We don't
  // have that signal in HOC-OES yet, so MONTHLY CASE GAP is skipped and
  // the WATCH bucket catches uncategorized non-green cases.
  function primaryConstraint(combinedR, oeeGap, plannedLaborHrs, remBatches){
    if(combinedR === 'GREEN') return 'NONE';
    if(oeeGap < 0)            return 'SPEED / OEE';
    if(plannedLaborHrs >= 400) return 'LABOR LOAD';
    if(remBatches >= 7)        return 'CAPACITY LOAD';
    return 'WATCH';
  }

  // ── Action Required (workbook col T) — full decision tree ────────────
  function actionRequired(combinedR, oeeGap, plannedLaborHrs, remBatches){
    if(combinedR === 'GREEN') return 'Monitor Only';
    if(combinedR === 'YELLOW'){
      if(oeeGap < 0)             return 'CHECK SPEED/OEE: Verify standard, stops, and settings';
      if(plannedLaborHrs >= 400) return 'ADD / REBALANCE 1 OPERATOR';
      if(remBatches >= 3)        return 'PROTECT NEXT BEST BATCH SEQUENCE';
      return 'Review Schedule';
    }
    if(combinedR === 'RED'){
      if(oeeGap < 0)             return 'GEMBA 24H: Fix OEE/speed loss';
      if(plannedLaborHrs >= 400) return 'IMMEDIATE: Add/rebalance labor';
      if(remBatches >= 7)        return 'RESCHEDULE: Reduce load / protect MUST RUN';
      return 'ESCALATE: Cross-functional review';
    }
    return '';
  }

  // ── Action Timing (workbook col U) ───────────────────────────────────
  function actionTiming(combinedR){
    if(combinedR === 'RED')    return 'TODAY';
    if(combinedR === 'YELLOW') return 'NEXT SHIFT';
    return 'STANDARD REVIEW';
  }

  // ── Look up per-line OEE actual from Patch (fraction 0..1) ───────────
  function getLineOEE(lineNum){
    var po = loadJSON('hoc_patch_oee_v1');
    if(!po || !po.lines) return null;
    var L = po.lines[lineNum] || po.lines[String(lineNum)];
    return L && L.oee != null ? L.oee : null;
  }

  // ── Look up per-line Attainment actual from live compute (fraction) ──
  function getLineAttainment(lineNum){
    if(typeof HOC_Attainment === 'undefined') return null;
    var pct = HOC_Attainment.lineAttainment(lineNum);
    return pct != null ? pct / 100 : null;
  }

  // ── Look up per-line Capacity row (rem batches, rem hrs, batch risk) ─
  function getCapacityRow(lineNum){
    if(typeof HOC_Capacity === 'undefined') return null;
    var rows = HOC_Capacity.lineSummary();
    var r = rows.find(function(x){ return x.line === lineNum; });
    return r || null;
  }

  // ── Read goals from hoc_kpi_manual_v1 (defaults 60% / 90%) ───────────
  function getGoals(){
    var k = loadJSON('hoc_kpi_manual_v1') || {};
    return {
      oee:    (k.oee_goal != null) ? Number(k.oee_goal) / 100 : 0.60,
      attain: (k.att_goal != null) ? Number(k.att_goal) / 100 : 0.90
    };
  }

  // ── Score one line — produces the full workbook row ──────────────────
  function scoreLine(lineNum){
    var goals = getGoals();
    var oeeActual = getLineOEE(lineNum);
    var attainActual = getLineAttainment(lineNum);
    var cap = getCapacityRow(lineNum);

    // Workbook fields B/C: OEE Actual / OEE Goal
    var oeeGap    = (oeeActual !== null) ? (oeeActual - goals.oee) : null;
    // Workbook fields E/F: Attain Actual / Goal
    var attainGap = (attainActual !== null) ? (attainActual - goals.attain) : null;
    // Workbook fields H/I/J: Remaining Batches / Hrs / Planned Labor Hrs
    var remBatches = cap ? cap.remaining_batches : 0;
    var remHrs     = cap ? cap.total_remaining_hrs : 0;
    var plannedLaborHrs = cap ? cap.planned_labor_hrs : 0;
    // Workbook field K: Batch Risk (from Line Summary)
    var batchRisk = cap ? cap.risk_status : null;

    // If we don't have OEE or Attainment data, we can't score — return
    // a partial row marked as such. The dashboard will display N/A.
    var hasOEE = oeeActual !== null;
    var hasAttain = attainActual !== null;
    var scorable = hasOEE && hasAttain && cap !== null;

    // For scoring, treat missing actuals as "at goal" (gap = 0) — this
    // matches workbook IFERROR(...,0) pattern at B13/E13.
    var oeeGapForScore    = oeeGap    !== null ? oeeGap    : 0;
    var attainGapForScore = attainGap !== null ? attainGap : 0;

    var risk    = combinedRisk(batchRisk, oeeGapForScore, attainGapForScore);
    var score   = priorityScore(oeeGapForScore, attainGapForScore, remBatches, remHrs);
    var tier    = priorityTier(score);
    var lock    = schedulerLock(tier);
    var sugg    = suggestedAction(batchRisk, risk);
    var constr  = primaryConstraint(risk, oeeGapForScore, plannedLaborHrs, remBatches);
    var actReq  = actionRequired(risk, oeeGapForScore, plannedLaborHrs, remBatches);
    var actTime = actionTiming(risk);

    return {
      line: lineNum,
      // Inputs
      oee_actual: oeeActual,                       // fraction 0..1 or null
      oee_goal:   goals.oee,                       // fraction
      oee_gap:    oeeGap,                          // fraction or null
      attain_actual: attainActual,                 // fraction or null
      attain_goal:   goals.attain,
      attain_gap:    attainGap,
      remaining_batches: remBatches,
      remaining_hrs:     remHrs,
      planned_labor_hrs: plannedLaborHrs,
      batch_risk: batchRisk,                       // from Line Summary
      // Outputs (workbook columns M-U)
      combined_risk: risk,
      suggested_action: sugg,
      priority_score: score,
      priority_tier:  tier,
      scheduler_lock: lock,
      primary_constraint: constr,
      action_required: actReq,
      action_timing: actTime,
      // Meta
      scorable: scorable,
      has_oee: hasOEE,
      has_attainment: hasAttain,
      has_capacity: cap !== null
    };
  }

  function scoreLines(){
    return SCORED_LINES.map(scoreLine);
  }

  // ── Public surface ───────────────────────────────────────────────────
  global.HOC_GoalEngine = {
    scoreLines: scoreLines,
    scoreLine: scoreLine,
    SCORED_LINES: SCORED_LINES.slice(),
    _internal: {
      combinedRisk: combinedRisk,
      priorityScore: priorityScore,
      priorityTier: priorityTier,
      schedulerLock: schedulerLock,
      suggestedAction: suggestedAction,
      primaryConstraint: primaryConstraint,
      actionRequired: actionRequired,
      actionTiming: actionTiming,
      getLineOEE: getLineOEE,
      getLineAttainment: getLineAttainment,
      getCapacityRow: getCapacityRow,
      getGoals: getGoals
    }
  };
})(typeof window !== 'undefined' ? window : global);
