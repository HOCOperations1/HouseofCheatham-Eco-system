/*
 * hoc_line_filter.js — v6.34bu
 *
 * Shared line filter dropdown for HOC-OES dashboards.
 *
 * WHAT IT DOES
 *   Renders a small dropdown ("All Lines" / "Line 1" / "Line 2" / ...) that
 *   remembers the operator's selection across dashboards and across page
 *   reloads. When the value changes, it fires a `linefilter:change` event
 *   that renderers can listen for.
 *
 * STORAGE
 *   Key: hoc_line_filter_v1
 *   Shape: { selected: 'all' | '<line-num-as-string>' }
 *
 * WIRE-UP (for a batch-table dashboard)
 *   1. Include: <script src="hoc_line_filter.js"></script>
 *   2. Add container: <div id="line-filter-mount"></div>
 *   3. Call: HocLineFilter.mount('#line-filter-mount');
 *   4. In your row-render function, filter with:
 *        rows = rows.filter(HocLineFilter.matchesRow);
 *   5. Listen for changes:
 *        window.addEventListener('linefilter:change', () => yourRenderFn());
 *
 * WIRE-UP (for a dashboard with no batch rows)
 *   Same steps 1-3, but pass { hint: true } to mount() so a small
 *   "(no effect on this view)" note appears under the dropdown. This is
 *   the honest signal to the operator that we're not lying about filtering
 *   here — the UI is present for consistency, not because it does anything.
 *
 * HONEST LIMITATIONS
 *   - Lines list is built from hoc_upload_v1.batches on mount. If uploads
 *     change while the dashboard is open, hit "Refresh Options" or reload.
 *   - The filter reads b.line for the match. Non-numeric line values are
 *     compared as strings. "All Lines" bypass the filter entirely.
 *   - Storage event listeners fire the change event automatically when
 *     another tab updates the selection.
 */
(function(){
  var STORAGE_KEY = 'hoc_line_filter_v1';

  function loadSelected(){
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return 'all';
      var parsed = JSON.parse(raw);
      return (parsed && parsed.selected) ? parsed.selected : 'all';
    } catch(e){ return 'all'; }
  }

  function saveSelected(val){
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ selected: val, _updated: Date.now() }));
    } catch(e){
      console.warn('hoc_line_filter: could not persist selection', e);
    }
  }

  // Discover distinct line values from hoc_upload_v1.batches.
  // Returns a sorted array of strings.
  function discoverLines(){
    try {
      var raw = localStorage.getItem('hoc_upload_v1');
      if(!raw) return [];
      var up = JSON.parse(raw);
      var batches = (up && Array.isArray(up.batches)) ? up.batches : [];
      var seen = {};
      batches.forEach(function(b){
        var ln = b.line;
        if(ln === null || ln === undefined || ln === '') return;
        seen[String(ln)] = true;
      });
      // Sort numerically when possible, alphabetically otherwise
      return Object.keys(seen).sort(function(a, b){
        var na = parseInt(a, 10), nb = parseInt(b, 10);
        if(!isNaN(na) && !isNaN(nb)) return na - nb;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    } catch(e){ return []; }
  }

  // Does a given batch/row pass the current filter?
  function matchesRow(row){
    var sel = loadSelected();
    if(sel === 'all') return true;
    if(!row || row.line === undefined || row.line === null) return false;
    return String(row.line) === String(sel);
  }

  // Get the currently-selected line value (for direct use in renderers).
  function getSelectedLine(){ return loadSelected(); }

  // Broadcast a change so open renderers can refresh.
  function fireChange(newValue){
    try {
      window.dispatchEvent(new CustomEvent('linefilter:change', {
        detail: { selected: newValue }
      }));
    } catch(e){}
  }

  // Mount the dropdown into a container. Options:
  //   { hint: true }  — show "(no effect on this view)" note
  //   { label: 'Filter by line' } — custom label text
  function mount(selectorOrEl, opts){
    opts = opts || {};
    var el = (typeof selectorOrEl === 'string')
      ? document.querySelector(selectorOrEl)
      : selectorOrEl;
    if(!el){
      console.warn('hoc_line_filter: mount target not found', selectorOrEl);
      return;
    }
    var lines = discoverLines();
    var current = loadSelected();
    // Reset to 'all' if the persisted line no longer exists in the data.
    // Honest signal — better to show all than to silently filter away everything.
    if(current !== 'all' && lines.indexOf(current) === -1){
      current = 'all';
      saveSelected('all');
    }

    var labelTxt = opts.label || 'Line filter:';
    var hintHtml = opts.hint
      ? '<span style="font-size:9px;color:var(--text3, #888);font-style:italic;margin-left:6px">(no effect on this view)</span>'
      : '';

    // Build the dropdown HTML. Kept compact so it fits in a topbar strip.
    var optionsHtml = '<option value="all"' + (current === 'all' ? ' selected' : '') + '>All Lines</option>';
    lines.forEach(function(ln){
      var isSelected = (String(current) === String(ln));
      optionsHtml += '<option value="' + ln + '"' + (isSelected ? ' selected' : '') + '>Line ' + ln + '</option>';
    });

    el.innerHTML =
      '<div class="hoc-line-filter" style="display:inline-flex;align-items:center;gap:6px;font-size:10px">' +
        '<label style="color:var(--text3, #888);font-weight:600;letter-spacing:.04em">' + labelTxt + '</label>' +
        '<select class="hoc-line-filter-select" style="padding:3px 8px;font:inherit;font-size:10px;font-weight:700;background:var(--bg3, #222);border:1px solid var(--border, #333);border-radius:4px;color:var(--text, #fff);cursor:pointer">' +
          optionsHtml +
        '</select>' +
        hintHtml +
      '</div>';

    var sel = el.querySelector('.hoc-line-filter-select');
    if(sel){
      sel.addEventListener('change', function(e){
        var v = e.target.value;
        saveSelected(v);
        fireChange(v);
      });
    }
  }

  // Refresh the mounted dropdown options — call this after a data upload
  // reveals new lines. Also fires a change event so renderers refresh.
  function refreshOptions(){
    var mounts = document.querySelectorAll('#line-filter-mount, .hoc-line-filter-mount');
    mounts.forEach(function(m){ mount(m); });
    fireChange(loadSelected());
  }

  // Listen for storage events so a change made in another tab or a
  // different dashboard is picked up when this one comes into focus.
  window.addEventListener('storage', function(e){
    if(e.key === STORAGE_KEY){
      var mounts = document.querySelectorAll('#line-filter-mount, .hoc-line-filter-mount');
      mounts.forEach(function(m){ mount(m); });
      fireChange(loadSelected());
    }
  });

  window.HocLineFilter = {
    mount: mount,
    matchesRow: matchesRow,
    getSelectedLine: getSelectedLine,
    refreshOptions: refreshOptions,
    discoverLines: discoverLines
  };
})();
