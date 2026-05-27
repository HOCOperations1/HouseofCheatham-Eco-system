// HOC-OES Events + Notifications Client
// All dashboards include this to fire audit events and surface notifications.
// Persists events to Supabase hoc_events table + localStorage queue (offline fallback).
(function(){
  if(window.HOC_EVENTS) return; // already loaded

  var SUPA_URL = 'https://yemtpvrumqvbzrzpwnyy.supabase.co';
  var SUPA_KEY = 'sb_publishable_YrMf3_sGly4dir1cEGErfg_SSusnfJl';
  var H = function(){ return {'apikey':SUPA_KEY,'Authorization':'Bearer '+SUPA_KEY,'Content-Type':'application/json'}; };
  var QKEY = 'hoc_event_queue_v1';
  var SEEN_KEY = 'hoc_event_seen_v1';

  // ── Fire an event ────────────────────────────────────────────────────
  // type: short event_type like 'material_blocker', 'qc_hold', 'will_miss', 'oee_drop'
  // payload: { batch, source, note, ... }
  // targets: array of roles that should see the notification
  function fire(type, payload, severity, targets){
    payload = payload || {};
    severity = severity || 'info';
    targets = targets || [];
    var row = {
      event_type: type,
      severity: severity,
      batch_id: payload.batch || payload.batch_id || null,
      item_id: payload.item || payload.item_id || null,
      source: payload.source || 'unknown',
      payload: Object.assign({ targets: targets, ts: Date.now() }, payload)
    };

    // Queue locally first so we never lose an event
    try {
      var q = JSON.parse(localStorage.getItem(QKEY)||'[]');
      q.unshift(Object.assign({_local_id: Date.now()+'_'+Math.random().toString(36).slice(2,6), _ts: Date.now()}, row));
      q = q.slice(0, 200); // cap
      localStorage.setItem(QKEY, JSON.stringify(q));
    } catch(e){}

    // Best-effort POST to Supabase
    try {
      fetch(SUPA_URL+'/rest/v1/hoc_events', {
        method: 'POST',
        headers: H(),
        body: JSON.stringify(row)
      }).catch(function(){});
    } catch(e){}

    // Trigger UI listeners
    try { window.dispatchEvent(new CustomEvent('hoc-event-fired', {detail: row})); } catch(e){}
  }

  // ── Pull recent events from Supabase ─────────────────────────────────
  function pullRecent(callback){
    try {
      fetch(SUPA_URL+'/rest/v1/hoc_events?order=created_at.desc&limit=50', {
        headers: H()
      }).then(function(r){ return r.ok ? r.json() : []; })
        .then(function(rows){ if(callback) callback(rows||[]); })
        .catch(function(){ if(callback) callback([]); });
    } catch(e){ if(callback) callback([]); }
  }

  // ── Notification center: roles & filtering ───────────────────────────
  function getCurrentRole(){
    try { return localStorage.getItem('hoc_user_role') || 'all'; } catch(e){ return 'all'; }
  }
  function setRole(role){
    try { localStorage.setItem('hoc_user_role', role); } catch(e){}
    try { window.dispatchEvent(new CustomEvent('hoc-role-changed', {detail:{role:role}})); } catch(e){}
  }
  function filterForRole(events, role){
    if(!role || role === 'all') return events;
    return events.filter(function(e){
      var t = (e.payload && e.payload.targets) || [];
      return t.indexOf(role) >= 0 || t.indexOf('all') >= 0;
    });
  }
  function markSeen(eventIds){
    try {
      var seen = JSON.parse(localStorage.getItem(SEEN_KEY)||'{}');
      eventIds.forEach(function(id){ seen[id] = Date.now(); });
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch(e){}
  }
  function getSeen(){
    try { return JSON.parse(localStorage.getItem(SEEN_KEY)||'{}'); } catch(e){ return {}; }
  }

  // ── Render notification bell (call from any dashboard topbar) ────────
  function renderBell(containerSelector){
    var el = document.querySelector(containerSelector);
    if(!el) return;
    pullRecent(function(events){
      var role = getCurrentRole();
      var filtered = filterForRole(events, role);
      var seen = getSeen();
      var unseen = filtered.filter(function(e){ return !seen[e.id]; });
      var unseenCount = unseen.length;
      var bell = '<div style="position:relative;display:inline-block">' +
        '<button id="hoc-bell-btn" title="Notifications · click to view" onclick="HOC_EVENTS.toggleBell()" style="background:none;border:1px solid rgba(255,255,255,.15);color:#94a3b8;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:inherit">🔔 ' +
        (unseenCount ? '<span style="background:#ef4444;color:white;border-radius:8px;padding:1px 6px;font-size:9px;font-weight:700;margin-left:4px">'+unseenCount+'</span>' : '') +
        '</button>' +
        '<div id="hoc-bell-panel" style="display:none;position:absolute;right:0;top:36px;width:380px;max-height:480px;overflow-y:auto;background:var(--bg2,#1a1f2e);border:1px solid var(--border,rgba(255,255,255,.1));border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.4);z-index:9999;padding:8px">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px 8px;border-bottom:1px solid var(--border,rgba(255,255,255,.08));margin-bottom:6px">' +
            '<span style="font-size:11px;font-weight:700;color:var(--text,#fff)">Notifications · '+role.toUpperCase()+'</span>' +
            '<button onclick="HOC_EVENTS.markAllSeen()" style="background:none;border:none;color:var(--blue,#3b82f6);font-size:10px;cursor:pointer">Mark all read</button>' +
          '</div>' +
          (filtered.length ? filtered.slice(0,30).map(function(e){
            var sev = e.severity || 'info';
            var col = sev === 'critical' ? 'var(--red,#ef4444)' : sev === 'warning' ? 'var(--amber,#f59e0b)' : 'var(--blue,#3b82f6)';
            var isUnseen = !seen[e.id];
            var when = e.created_at ? new Date(e.created_at).toLocaleString('en-US',{month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
            var payload = e.payload || {};
            var msg = payload.message || payload.note || payload.blocker || e.event_type;
            return '<div style="padding:6px 8px;border-left:2px solid '+col+';background:'+(isUnseen?'rgba(255,255,255,.04)':'transparent')+';margin-bottom:4px;border-radius:4px;font-size:10px">' +
              '<div style="display:flex;justify-content:space-between"><span style="font-weight:700;color:'+col+'">'+e.event_type.toUpperCase()+'</span><span style="color:var(--text3,#64748b);font-size:9px">'+when+'</span></div>' +
              (e.batch_id ? '<div style="color:var(--text2,#94a3b8);font-size:10px">'+e.batch_id+'</div>' : '') +
              '<div style="color:var(--text,#fff);font-size:10px;margin-top:2px">'+msg+'</div>' +
              '<div style="color:var(--text3,#64748b);font-size:9px;margin-top:1px">from '+(e.source||'unknown')+'</div>' +
            '</div>';
          }).join('') : '<div style="text-align:center;padding:20px;color:var(--text3,#64748b);font-size:11px">No notifications</div>') +
        '</div></div>';
      el.innerHTML = bell;
    });
  }
  function toggleBell(){
    var panel = document.getElementById('hoc-bell-panel');
    if(panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }
  function markAllSeen(){
    pullRecent(function(events){
      var role = getCurrentRole();
      var filtered = filterForRole(events, role);
      markSeen(filtered.map(function(e){ return e.id; }));
      renderBell('#hoc-bell-mount');
    });
  }

  // ── Role picker UI ───────────────────────────────────────────────────
  function renderRolePicker(containerSelector){
    var el = document.querySelector(containerSelector);
    if(!el) return;
    var role = getCurrentRole();
    var roles = [
      {v:'all', l:'All Roles'},
      {v:'production_supervisor', l:'Production Supervisor'},
      {v:'compound_coordinator', l:'Compound Coordinator'},
      {v:'compound_scheduler', l:'Compound Scheduler'},
      {v:'preweigh_operator', l:'PreWeigh Operator'},
      {v:'qc_team', l:'QC Team'},
      {v:'production_coordinator', l:'Production Coordinator'},
      {v:'procurement', l:'Procurement'},
      {v:'demand_supply', l:'Demand & Supply'},
      {v:'maintenance', l:'Maintenance'},
      {v:'leadership', l:'Leadership'},
    ];
    el.innerHTML = '<select title="Set your role to filter notifications" onchange="HOC_EVENTS.setRole(this.value); HOC_EVENTS.renderBell(\'#hoc-bell-mount\');" style="background:#0f1419;color:#fff;border:1px solid rgba(255,255,255,.15);padding:4px 8px;border-radius:6px;font-size:10px;cursor:pointer;font-family:inherit">' +
      roles.map(function(r){
        return '<option value="'+r.v+'" style="background:#0f1419;color:#fff"'+(r.v===role?' selected':'')+'>'+r.l+'</option>';
      }).join('') + '</select>';
  }

  // ── Auto-init: drop a bell + role picker into the topbar of any dashboard ─
  function autoInit(){
    if(document.getElementById('hoc-bell-mount')) return; // already mounted
    // Find the topbar
    var topbar = document.querySelector('.topbar') || document.querySelector('header') || document.querySelector('.brand');
    var mount = document.createElement('div');
    if(topbar){
      mount.style.cssText = 'margin-left:auto;display:flex;gap:8px;align-items:center';
      mount.innerHTML = '<div id="hoc-role-mount"></div><div id="hoc-bell-mount"></div>';
      topbar.appendChild(mount);
    } else {
      // No topbar — fall back to a floating overlay in the top-right corner
      mount.style.cssText = 'position:fixed;top:10px;right:14px;z-index:9998;display:flex;gap:8px;align-items:center;background:rgba(15,20,25,.92);padding:5px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.08);backdrop-filter:blur(6px)';
      mount.innerHTML = '<div id="hoc-role-mount"></div><div id="hoc-bell-mount"></div>';
      document.body.appendChild(mount);
    }
    renderRolePicker('#hoc-role-mount');
    renderBell('#hoc-bell-mount');
    // Refresh bell every 30s
    setInterval(function(){ renderBell('#hoc-bell-mount'); }, 30000);
    // Close panel on outside click
    document.addEventListener('click', function(e){
      var panel = document.getElementById('hoc-bell-panel');
      var btn = document.getElementById('hoc-bell-btn');
      if(panel && panel.style.display === 'block' && !panel.contains(e.target) && e.target !== btn) {
        panel.style.display = 'none';
      }
    });
  }

  window.HOC_EVENTS = {
    fire: fire,
    pullRecent: pullRecent,
    renderBell: renderBell,
    toggleBell: toggleBell,
    markAllSeen: markAllSeen,
    setRole: setRole,
    getCurrentRole: getCurrentRole,
    renderRolePicker: renderRolePicker
  };

  if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})();
