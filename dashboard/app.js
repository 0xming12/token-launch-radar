// Token Radar v2 dashboard. Reads window.RADAR (data.js, written by main.ts
// from the same board.json) and renders the board, filters, detail view and
// the fitted model's methodology. No network: every byte shown is in data.js.
(function () {
  'use strict';
  var DATA = window.RADAR; if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', cat: 'all', chain: 'all', verdict: 'all', watch: false, tab: 'pre', sort: 'implied', dir: -1, sel: null };
  var fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function usd(n) { if (n == null || !isFinite(n)) return 'n/a'; if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'; if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M'; if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K'; return fmt.format(n); }
  function pct(n) { if (n == null || !isFinite(n)) return 'n/a'; return (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function age(d) { if (d == null) return 'unknown'; return d >= 365 ? (d / 365).toFixed(1) + 'y' : Math.max(0, Math.round(d)) + 'd'; }
  function el(t, a) {
    var n = document.createElement(t);
    if (a) Object.keys(a).forEach(function (k) { if (k === 'class') n.className = a[k]; else if (k === 'text') n.textContent = a[k]; else if (k === 'html') n.innerHTML = a[k]; else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), a[k]); else if (a[k] != null) n.setAttribute(k, a[k]); });
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null) continue; if (Array.isArray(c)) c.forEach(function (x) { if (x) n.appendChild(x); }); else if (typeof c === 'string') n.appendChild(document.createTextNode(c)); else n.appendChild(c); }
    return n;
  }
  function rows() {
    var r = DATA.rows.filter(function (x) {
      if (state.watch && DATA.watchlist.indexOf(x.slug) < 0) return false;
      if (state.cat !== 'all' && (x.category || 'Other') !== state.cat) return false;
      if (state.chain !== 'all' && (!x.chains || x.chains.indexOf(state.chain) < 0)) return false;
      if (state.verdict !== 'all' && x.verdict !== state.verdict) return false;
      if (state.q && (x.name + ' ' + x.slug + ' ' + (x.category || '')).toLowerCase().indexOf(state.q.toLowerCase()) < 0) return false;
      return true;
    });
    var k = state.sort;
    r.sort(function (a, b) { var d = (a[k] - b[k]) || (a.implied_value_usd - b.implied_value_usd); return state.dir * d; });
    return r;
  }
  function header() {
    return el('header', null, el('div', null,
      el('div', { class: 'brand', text: 'Token Radar · radar-2-fitted · snapshot ' + DATA.as_of }),
      el('h1', { text: 'Which pre-token protocol is worth farming next?' }),
      el('p', { class: 'lede sub', text: DATA.board_size + ' pre-token protocols ranked by fitted implied value — what a launch would be worth if the protocol launched at its peers\' price. Every multiple is fitted from the ' + DATA.fit.livePeersUsed + ' live-token protocols in this snapshot, never hard-coded by name. Implied values are order-of-magnitude estimates: the honest band is about x/4.' })),
      el('div', { class: 'sub', text: 'Source: ' + DATA.source + ' · Watchlist floor $' + (DATA.floor_usd / 1e6) + 'M' }));
  }
  function kpis() {
    var k = DATA.kpi, f = DATA.fit;
    var items = [
      [DATA.board_size + ' rows', 'pre-token protocols ranked'],
      [DATA.watchlist_size + ' on watchlist', 'every one covered, floor not ceiling'],
      [usd(k.total_implied_usd), 'total fitted implied value'],
      [Math.round(k.median_odds * 100) + '%', 'median token odds (peer launch rate)'],
      [k.farm_count + ' FARM', k.watch_count + ' WATCH · rest SKIP'],
      [f.livePeersUsed + ' peers', 'live-token protocols fitted (of ' + f.livePeers + ' with a market cap)']];
    return el('div', { class: 'kpis' }, items.map(function (x) { return el('div', { class: 'kpi' }, el('b', { text: x[0] }), el('span', { text: x[1] })); }));
  }
  function controls() {
    var cats = ['all'].concat(Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort());
    var chains = ['all'].concat(Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort());
    function sel(id, opts, val, fn) { var s = el('select', { id: id, 'aria-label': id, onchange: fn }); opts.forEach(function (o) { var op = el('option', { value: o, text: o === 'all' ? 'All ' + id : o }); if (o === val) op.selected = true; s.appendChild(op); }); return s; }
    return el('div', { class: 'controls' },
      el('input', { type: 'search', placeholder: 'Search protocol…', value: state.q, oninput: function (e) { state.q = e.target.value; render(); } }),
      sel('category', cats, state.cat, function (e) { state.cat = e.target.value; render(); }),
      sel('chain', chains, state.chain, function (e) { state.chain = e.target.value; render(); }),
      sel('verdict', ['all', 'FARM', 'WATCH', 'SKIP'], state.verdict, function (e) { state.verdict = e.target.value; render(); }),
      el('button', { class: 'pill ' + (state.watch ? 'FARM' : 'SKIP'), text: state.watch ? 'Watchlist only: on' : 'Watchlist only: off', onclick: function () { state.watch = !state.watch; render(); } }));
  }
  function tabs() {
    return el('div', { class: 'tabs' },
      el('button', { 'aria-pressed': String(state.tab === 'pre'), text: 'Pre-token board (' + DATA.board_size + ')', onclick: function () { state.tab = 'pre'; render(); } }),
      el('button', { 'aria-pressed': String(state.tab === 'live'), text: 'Live tokens (' + DATA.live_size + ') — already trade', onclick: function () { state.tab = 'live'; render(); } }));
  }
  function boardTable() {
    var list = rows().slice(0, 120);
    var max = DATA.rows[0] ? DATA.rows[0].implied_value_usd : 1;
    var tb = el('tbody');
    list.forEach(function (r) {
      tb.appendChild(el('tr', { 'data-selected': String(state.sel === r.slug), tabindex: '0', onclick: function () { openDetail(r.slug); }, onkeydown: function (e) { if (e.key === 'Enter') openDetail(r.slug); } },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains || []).slice(0, 2).join(', ') }))),
        el('td', { class: 'num', text: usd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d != null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
        el('td', { class: 'num', text: Math.round(r.token_odds * 100) + '%' }),
        el('td', { class: 'num', text: String(r.integrity) }),
        el('td', null, el('div', null, el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round(r.implied_value_usd / max * 100)) + '%' })), el('span', { class: 'num', text: usd(r.implied_value_usd) }))),
        el('td', { class: 'num', text: usd(r.expected_value_usd) }),
        el('td', null, el('span', { class: 'pill ' + r.verdict, text: r.verdict }))));
    });
    function th(key, label) { return el('th', { class: 'num', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'rank' ? 1 : -1; } render(); }, text: label + (state.sort === key ? (state.dir < 0 ? ' ↓' : ' ↑') : '') }); }
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' }, el('table', null,
      el('caption', { class: 'sub', text: 'Showing ' + list.length + ' of ' + rows().length + ' matching rows. Click a row for its model breakdown and farm plan. Implied value is the launch value if it launched; expected value is implied × token odds.' }),
      el('thead', null, el('tr', null, th('rank', 'Rank'), el('th', { text: 'Protocol' }), th('tvl_usd', 'TVL'), th('change_7d', '7d'), th('token_odds', 'Odds'), th('integrity', 'Integrity'), th('implied_value_usd', 'Implied value'), th('expected_value_usd', 'Expected value'), el('th', { text: 'Verdict' }))),
      tb)));
  }
  function liveTable() {
    var tb = el('tbody');
    DATA.live.forEach(function (r) { tb.appendChild(el('tr', null, el('td', { class: 'num', text: 'live' }), el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains || []).slice(0, 2).join(', ') }))), el('td', { class: 'num', text: usd(r.tvl_usd) }), el('td', { class: 'num ' + (r.change_7d != null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }), el('td', { class: 'num', text: usd(r.mcap_usd) }), el('td', null, el('span', { class: 'pill SKIP', text: 'already trades' })))); });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' }, el('table', null, el('caption', { class: 'sub', text: 'These protocols already trade, so their market cap is a fact, not a model. They are the peers the fitted multiples come from, and they are set aside from the pre-token ranking.' }), el('thead', null, el('tr', null, el('th', { text: 'Status' }), el('th', { text: 'Protocol' }), el('th', { class: 'num', text: 'TVL' }), el('th', { class: 'num', text: '7d' }), el('th', { class: 'num', text: 'Market cap' }), el('th', { text: 'Token' }))), tb)));
  }
  function methodPanel() {
    var f = DATA.fit, v = f.validation;
    return el('section', { class: 'panel' },
      el('h2', { text: 'How implied value is computed — and how wrong it can be' }),
      el('div', { class: 'formula', text: 'implied = TVL × category_multiple × (1 + clamp(7d growth, -30, +60)% × 0.30) × (0.85 + min(age, 1095)/1095 × 0.20)' }),
      el('p', { class: 'sub', text: 'category_multiple is the median market-cap / TVL of live-token protocols in the same category, shrunk toward the global median ' + f.globalMultiple.toFixed(3) + ' (10 pseudo-observations) and clamped to 0.02–1.50. Token odds blend the peer launch rate by category, TVL bucket and age bucket. No protocol name is special-cased; the same function scores every row, and the page recomputes each row from the same figures.' }),
      el('p', { class: 'sub', text: 'Validation, held out twice before ranking: log-log regression R² = ' + v.r2_log + ' on 128 live protocols. Category-median model, mean absolute log error ' + v.heldout_mae_log_seed7 + ' (seed 7) and ' + v.heldout_mae_log_seed42 + ' (seed 42); time split (older → newer) ' + v.heldout_mae_log_time + '; flat 0.25× starter ' + v.starter_mae_log + '. Median absolute error is 81–90% — treat every implied value as ± about 4×, and farm the verdict, not the number.' }),
      el('p', { class: 'sub', text: 'All ' + DATA.total_protocols + ' protocols in the snapshot are accounted for: ' + DATA.board_size + ' ranked pre-token rows, ' + DATA.live_total + ' live-token protocols set aside (' + DATA.live_size + ' shown; their market caps are facts, not models), and ' + DATA.excluded_pre_token + ' pre-token protocols excluded as wrapped, staked, bridged, CEX or versioned products of a token that already trades — listed in the model, never ranked as launches.' }),
      el('div', { class: 'warn', text: 'A protocol that records no token may still have one its DefiLlama record does not carry. Implied value is this entry\'s claim, never a price, and never a prediction that a token will launch, or when.' }));
  }
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0]; if (!row) return;
    state.sel = slug; dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'detail-head' }, el('div', null, el('span', { class: 'brand', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' · ' + row.verdict }), el('h2', { id: 'detail-title', text: row.name }), el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains || []).join(', ') + ' · records no token' })), el('button', { class: 'close', type: 'button', text: 'Close', onclick: function () { dialog.close(); } })));
    dialog.appendChild(el('section', null, el('h3', { text: 'Model breakdown' }), el('div', { class: 'equation' },
      el('div', null, el('span', { text: 'TVL' }), el('b', { text: usd(row.tvl_usd) })),
      el('div', null, el('span', { text: 'Category multiple' }), el('b', { text: String(row.model.category_multiple) })),
      el('div', null, el('span', { text: '7d growth' }), el('b', { text: pct(row.change_7d) })),
      el('div', null, el('span', { text: 'Growth × maturity' }), el('b', { text: row.model.growth_multiplier + ' × ' + row.model.maturity_multiplier })),
      el('div', null, el('span', { text: 'Age with no token' }), el('b', { text: age(row.age_days) })),
      el('div', null, el('span', { text: 'Token odds' }), el('b', { text: Math.round(row.token_odds * 100) + '%' })),
      el('div', null, el('span', { text: 'Implied value' }), el('b', { text: usd(row.implied_value_usd) })),
      el('div', null, el('span', { text: 'Expected value' }), el('b', { text: usd(row.expected_value_usd) })),
      el('div', null, el('span', { text: 'Integrity' }), el('b', { text: row.integrity + ' / 100' })),
      el('div', null, el('span', { text: 'Flags' }), el('b', { text: row.flags.length ? row.flags.join('; ') : 'none' })))));
    dialog.appendChild(el('section', null, el('h3', { text: 'Farm plan — costed' }), el('ol', { class: 'steps' }, row.farm_steps.map(function (s) { var at = s.indexOf(' Cost: '); return el('li', null, el('b', { text: at >= 0 ? s.slice(0, at) : s }), el('span', { class: 'cost', text: at >= 0 ? s.slice(at + 1) : '' })); }))));
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal(); else dialog.setAttribute('open', '');
  }
  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header()); shell.appendChild(kpis()); shell.appendChild(controls()); shell.appendChild(tabs());
    shell.appendChild(state.tab === 'pre' ? boardTable() : liveTable());
    if (state.tab === 'pre') shell.appendChild(methodPanel());
    shell.appendChild(el('footer', { text: 'Token Radar v2 · fitted from DefiLlama snapshot ' + DATA.as_of + ' · ' + DATA.board_size + ' pre-token rows, ' + DATA.live_size + ' live peers shown · Implied values are estimates, not prices.' }));
    app.appendChild(shell);
    if (!dialog.isConnected) app.appendChild(dialog);
    app.setAttribute('aria-busy', 'false');
  }
  render();
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });
})();
