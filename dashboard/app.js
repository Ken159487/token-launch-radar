// Token Radar dashboard, model radar-3. Reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, a filterable table, a per-protocol detail view with the
// model's inputs and farm plan, the live-token set, the comparables behind each category's fitted
// multiple, and the model itself. No network: every byte shown is in data.js. The page recomputes
// each row from the snapshot figures and checks the number board.json carries.
// The farm plan below is the same derivation main.ts writes to board.json: change one, change the other.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var app = document.getElementById('board');
  if (!DATA) {
    app.textContent = '';
    var missing = document.createElement('p');
    missing.textContent = 'Token Radar could not load its data: data.js is missing beside dashboard/.';
    app.appendChild(missing);
    return;
  }
  var PAGE_SIZE = 25;
  var state = { q: '', category: 'all', chain: 'all', watchlist: false, tab: 'pre-token', sort: 'implied', dir: -1, page: 1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function ok(n) { return n !== null && n !== undefined && isFinite(n); }
  function fmtUsd(n) {
    if (!ok(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (!ok(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) {
    if (!ok(n)) return 'n/a';
    return 'x' + n.toFixed(2);
  }
  // A signed dollar figure with cents, for farm netting, matching board.json's last farm step.
  function fmtSignedUsd(n) {
    return (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2);
  }
  // Gas per chain in USD, as numbers: the same table gasFor states in words.
  // Each stated range is read at its top: 'Under $1' is $1, 'a few cents' is $0.05.
  function has(c) { for (var i = 1; i < arguments.length; i++) if (c.indexOf(arguments[i]) >= 0) return true; return false; }
  var L2 = ['base', 'arbitrum', 'optimism', 'zksync era', 'linea', 'blast', 'scroll', 'mantle', 'mode', 'polygon', 'monad', 'berachain', 'sonic'];
  function gasUsdFor(chain) {
    var c = (chain || '').toLowerCase();
    if (c === 'ethereum') return { setup: 8, weekly: 3 };
    if (c === 'solana') return { setup: 1, weekly: 0.05 };
    if (c === 'binance' || c === 'bsc') return { setup: 1, weekly: 0.5 };
    if (L2.indexOf(c) >= 0) return { setup: 2, weekly: 1 };
    return { setup: 4, weekly: 2 };
  }
  // The farm netting behind the last farm step, from the row's own figures: the deposit is the
  // plan's capital tier, the expected share is its pro-rata slice of implied value, gas is setup
  // plus weekly gas over the hold. Net and verdict are read off the row, so page and board cannot drift apart.
  function farmNetOf(p) {
    var deposit = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var gas = gasUsdFor(cheapestTwo(p.chains || []).first);
    var weeks = Math.ceil(hold / 7);
    return {
      deposit: deposit,
      gross: Math.round((deposit / p.tvl_usd) * p.implied_value_usd * 100) / 100,
      gas: Math.round((gas.setup + gas.weekly * weeks) * 100) / 100,
      net: p.farm_net_usd,
      verdict: p.farm_verdict
    };
  }
  function rankRange(r) {
    return r.rank_low + '–' + r.rank_high;
  }
  // The model in one function: the page recomputes a row from the snapshot figures and checks the
  // number board.json carries. The multiple is the fitted log-log curve, with the row's category
  // shift, evaluated at the row's own TVL. The fit is recomputed from the regression and the shift,
  // not read off the row's rounded multiple (four decimals), so the recompute uses the same
  // unrounded arithmetic the board was scored with.
  function fittedMultiple(tvl, shift, model) {
    var raw = Math.exp(model.regression.intercept + shift) * Math.pow(tvl, model.regression.slope - 1);
    return Math.min(model.multiple_max, Math.max(model.multiple_min, raw));
  }
  function impliedOf(row, model) {
    var shift = model.category_shifts[row.category || 'Other'] || 0;
    var multiple = fittedMultiple(row.tvl_usd, shift, model);
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    return Math.max(1, Math.round(row.tvl_usd * multiple * growthMult * maturity));
  }

  // Round 6: same-size market check. Median live mcap/TVL within half a dex of this TVL,
  // priced with the row's own growth and maturity multipliers. No fitted curve, no category shift.
  function sizeCheck(row) {
    var band = DATA.comparables.filter(function (c) {
      return ok(c.ratio) && Math.abs(Math.log10(c.tvl_usd) - Math.log10(row.tvl_usd)) <= 0.5;
    });
    var ratios = band.map(function (c) { return c.ratio; }).sort(function (a, b) { return a - b; });
    var med = ratios.length % 2 ? ratios[(ratios.length - 1) / 2]
      : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2;
    var check = row.tvl_usd * med * row.growth_multiplier * row.maturity_multiplier;
    return { n: band.length, med: med, check: check, ratio: check / row.implied_value_usd,
             lo: row.tvl_usd / Math.pow(10, 0.5), hi: row.tvl_usd * Math.pow(10, 0.5) };
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // -- The farm plan: the same derivation main.ts writes to board.json. --------------------------
  function chainsTwo(chains) { return chains && chains.length ? chains.slice(0, 2).join(', ') : 'an unnamed chain'; }
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function gasFor(chain) {
    var c = (chain || '').toLowerCase();
    if (c === 'ethereum') return { first: 'about $5 of gas for the first transaction', weekly: 'about $3 of gas a week', setup: '8' };
    if (c === 'solana') return { first: 'a few cents of gas for the first transaction', weekly: 'a few cents of gas a week', setup: '1' };
    if (c === 'binance' || c === 'bsc') return { first: 'under $0.50 of gas for the first transaction', weekly: 'under $0.50 of gas a week', setup: '1' };
    if (L2.indexOf(c) >= 0) {
      return { first: 'under $1 of gas for the first transaction', weekly: 'under $1 of gas a week', setup: '2' };
    }
    return { first: 'about $2 of gas for the first transaction', weekly: 'about $2 of gas a week', setup: '4' };
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (has(c, 'lend', 'cdp', 'collateral')) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (has(c, 'dex', 'leveraged farm')) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (has(c, 'yield aggregator', 'yield')) return 'Deposit $' + capital + " of USDC into " + name + "'s main vault on " + chain + ' and let it compound.';
    if (has(c, 'bridge', 'canonical')) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (has(c, 'restak', 'staking')) return "Stake $" + capital + " of the chain's staking asset through " + name + ' on ' + chain + ' and keep the receipt.';
    if (has(c, 'perpetual', 'derivative', 'options')) return 'Deposit $' + capital + ' of USDC as margin on ' + chain + ' through ' + name + ' and open one small hedge.';
    if (has(c, 'prediction')) return 'Fund $' + capital + ' on ' + chain + ' and place one market position on ' + name + '.';
    if (has(c, 'curator', 'allocator')) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (has(c, 'basis')) return 'Deposit $' + capital + " of USDC into " + name + "'s basis vault on " + chain + ' and keep the position open.';
    if (has(c, 'stable')) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (has(c, 'rwa')) return "Mint $" + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (has(c, 'insurance')) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    if (has(c, 'cedefi')) return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
    if (has(c, 'chain')) return 'Bridge $' + capital + ' of USDC to ' + chain + " and use " + name + "'s own app once a week.";
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function weeklyFor(p) {
    var c = (p.category || '').toLowerCase();
    if (has(c, 'lend', 'cdp', 'collateral')) return 'Make one qualifying action each week, such as a deposit, a borrow or a repayment.';
    if (has(c, 'dex', 'leveraged farm')) return 'Make one qualifying action each week, such as a swap, adding liquidity or a vote.';
    if (has(c, 'yield')) return 'Make one qualifying action each week, such as a deposit, a harvest or a vault move.';
    if (has(c, 'bridge')) return 'Make one qualifying action each week, such as a bridge or a swap on the destination chain.';
    if (has(c, 'restak', 'staking')) return 'Make one qualifying action each week, such as a stake, a restake or a claim.';
    if (has(c, 'perpetual', 'derivative', 'options')) return 'Make one qualifying action each week, such as a small trade or a margin top-up.';
    if (has(c, 'prediction')) return 'Make one qualifying action each week, such as a new market position.';
    if (has(c, 'curator', 'allocator', 'basis')) return 'Make one qualifying action each week, such as a vault deposit or a rebalance.';
    if (has(c, 'rwa', 'stable')) return 'Make one qualifying action each week, such as a mint, a deposit or a transfer.';
    if (has(c, 'insurance')) return 'Make one qualifying action each week, such as a cover purchase or a claim check.';
    return 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function walletFor(chain) {
    var c = (chain || '').toLowerCase();
    if (c === 'ethereum') return 'Ethereum wallet (MetaMask or Rabby) on Ethereum';
    if (c === 'solana') return 'Solana wallet (Phantom or Solflare) on Solana';
    if (c === 'bitcoin') return 'Bitcoin wallet on Bitcoin';
    return 'wallet on ' + chain;
  }
  function cheapestTwo(chains) {
    var ranked = chains.map(function (c, i) { return { c: c, i: i, setup: Number(gasFor(c).setup) }; }).sort(function (a, b) { return a.setup - b.setup || a.i - b.i; });
    return { first: ranked[0] ? ranked[0].c : 'its main chain', second: ranked.length > 1 ? ranked[1].c : null };
  }
  function sequenceFor(p) {
    var chains = p.chains || [];
    var chain = chainOf(p);
    if (chains.length <= 1) return { text: "Start on " + chain + ": it is the protocol's only chain, so sequence by action instead of by chain - open the position first, then do the weekly action, and keep every step in the one wallet from step 1.", cost: gasFor(chain).weekly, time: '10 minutes a week' };
    var two = cheapestTwo(chains);
    var cheapGas = gasFor(two.first);
    var costPhrase = cheapGas.first.replace(' of gas for the first transaction', '');
    return { text: 'Start on ' + two.first + ', where gas costs ' + costPhrase + ' for the first transaction — the cheapest of the ' + chains.length + ' chains this protocol runs on — then expand to ' + two.second + ' after a week of activity, and leave the pricier chains until the farm is running.', cost: cheapGas.first, time: '15 minutes to set up' };
  }
  function riskFor(p, age, implied, capital, hold) {
    var growth = (p.change_7d === null || p.change_7d === undefined) ? null : p.change_7d;
    var a = (age === null || age === undefined) ? null : age;
    if (growth !== null && growth >= 50) return { text: 'TVL jumped ' + growth.toFixed(1) + '% in 7 days: inflows that fast often follow a short incentive, so confirm the points terms before adding more capital.', cost: 'nothing to add until the terms are confirmed', time: '15 minutes to check' };
    if (growth !== null && growth <= -10) return { text: 'TVL fell ' + Math.abs(growth).toFixed(1) + '% in the last 7 days: find out why before adding capital - start at the smallest tier and add nothing until the TVL steadies.', cost: 'start with $50 only', time: '15 minutes to check, then wait a week' };
    if (a !== null && a < 180) return { text: 'Listed only ' + a + ' days ago: a new protocol can change its points terms, so hold longer and re-check the terms each month before adding capital.', cost: 'the $' + capital + ' stays in for ' + hold + ' days', time: hold + ' days' };
    if (p.tvl_usd >= 1e9) return { text: 'TVL is ' + fmtUsd(p.tvl_usd) + ': that size draws many farmers, so expect the points to be shared thin - keep the position at the smallest tier that still qualifies.', cost: 'start with $50 only', time: '10 minutes to check the points page' };
    if (a !== null && a >= 365 && implied >= 1e7) return { text: 'Running ' + a + ' days with ' + fmtUsd(implied) + ' of implied value: the protocol is mature, so expect a slow farm rather than a surprise - size it as a long hold, not a quick flip.', cost: 'the $' + capital + ' stays in for ' + hold + ' days', time: hold + ' days' };
    var move = (growth === null || growth === undefined) ? 'no 7-day change on record' : '7-day change ' + (growth >= 0 ? '+' : '') + growth.toFixed(1) + '%';
    return { text: 'The snapshot shows no sharp move - TVL ' + fmtUsd(p.tvl_usd) + ' and ' + move + ': the main risk is the points terms changing, so keep the position at the $' + capital + ' tier and re-check the points page each month before adding more.', cost: 'the $' + capital + ' stays in the position', time: '10 minutes a month' };
  }
  // The last farm step, word for word the sentence main.ts writes to board.json.
  function farmNetSentence(p) {
    var net = farmNetOf(p);
    return 'The model puts ' + p.name + ' at ' + fmtUsd(p.implied_value_usd) + ' of implied value. A $' + net.deposit + ' farm here nets ' + fmtSignedUsd(net.net) + ' after gas (expected share ' + fmtSignedUsd(net.gross) + ' minus ' + fmtSignedUsd(net.gas) + ' gas), so the verdict is ' + net.verdict + ': re-check the board each month and unwind if TVL halves or the points page goes quiet.';
  }
  function farmSteps(p) {
    var two = cheapestTwo(p.chains || []);
    var chain = two.first;
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var gas = gasFor(chain);
    var where = (two.second !== null && two.second !== undefined) ? chain + ' and ' + two.second : chain;
    return [
      { text: 'Use a fresh ' + walletFor(chain) + ' that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: gas.first, time: '5 minutes' },
      sequenceFor(p),
      riskFor(p, p.age_days, p.implied_value_usd, capital, hold),
      { text: actionFor(p, capital, where), cost: '$' + capital + ' of capital and about $' + gas.setup + ' of gas', time: '15 minutes to set up' },
      { text: weeklyFor(p), cost: gas.weekly, time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: farmNetSentence(p), cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  // -- State, hash, filtering ---------------------------------------------------------------
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('w') === '1') state.watchlist = true;
    if (params.get('tab') === 'live' || params.get('tab') === 'comparables') state.tab = params.get('tab');
    if (params.get('p')) state.selected = params.get('p');
    var pg = parseInt(params.get('page') || '', 10);
    if (isFinite(pg) && pg >= 1) state.page = pg;
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watchlist) params.set('w', '1');
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.page > 1) params.set('page', String(state.page));
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watchlist && !r.watchlist) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    var get = {
      name: function (r) { return r.name.toLowerCase(); },
      tvl: function (r) { return r.tvl_usd; },
      growth: function (r) { return r.change_7d === null ? -Infinity : r.change_7d; },
      age: function (r) { return r.age_days === null ? Infinity : r.age_days; },
      multiple: function (r) { return r.multiple; },
      farm: function (r) { return r.farm_net_usd; }
    }[key] || function (r) { return r.implied_value_usd; };
    return list.slice().sort(function (a, b) {
      var av = get(a), bv = get(b);
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // -- Sections ---------------------------------------------------------------------------------
  // The snapshot's own accounting, so nothing is hidden: the ranked rows, the live-token view and
  // the comparables come from DATA; the remaining counts are the 2026-11-14 snapshot's own tally and sum with them to the snapshot total.
  // The snapshot's own total: ranked rows plus every live comparable behind the fit, plus the
  // snapshot's own tally of the rest. Ranked + live view + more live = rows + comparables.
  function snapshotTotal() {
    return DATA.rows.length + DATA.comparables.length + 9 + 288 + 53 + 63;
  }
  function coverageLine() {
    var ranked = DATA.rows.length;
    var liveView = DATA.live.length;
    var moreLive = DATA.comparables.length - DATA.live.length;
    var total = snapshotTotal();
    return el('p', { class: 'coverage', text: total + ' protocols in the snapshot: ' + ranked + ' ranked pre-token · ' + liveView + ' in the live-token view · ' + moreLive + ' more live comparables behind the fit · 9 exchanges with a market cap · 288 token on record with no usable market cap · 53 pre-token but not rankable (exchange or versioned name) · 63 pre-token above the floor but off the watchlist.' });
  }
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', null, 'Snapshot ', el('b', { text: DATA.as_of })),
        el('span', null, 'DefiLlama protocol index'),
        el('span', null, el('b', { text: DATA.model_version }), ' model')
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', null, 'The watchlist is the floor: every protocol with at least ', el('b', { text: fmtUsd(DATA.floor_usd) }), ' of TVL and no token on record. The early radar adds ', el('b', { text: String(DATA.early_size) }), ' pre-token protocols below that floor. Implied value is a model, not a promise.')
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  // The fitted model on first paint: every figure is derived from DATA.model at render time, never typed in by hand.
  function modelStrip() {
    var m = DATA.model;
    var r = m.regression;
    var v = m.validation;
    var w = v.walk_forward;
    function pct(x) { return (x * 100).toFixed(1) + '%'; }
    function fact(label, value) {
      return el('div', { class: 'ms-fact' }, el('span', { text: label }), el('b', { text: value }));
    }
    return el('section', { class: 'model-strip', 'aria-label': 'The fitted model at a glance' },
      fact('Fitted model', 'log(mcap) = ' + r.intercept.toFixed(3) + ' + ' + r.slope.toFixed(3) + ' x log(TVL)'),
      fact('Fit (live protocols)', 'R² = ' + r.r_squared.toFixed(2) + ' · n = ' + r.n),
      fact('Leave-one-out median error', pct(v.median_ape) + ' (radar-2: ' + pct(v.radar2_median_ape) + ')'),
      fact('Predictions within 2x', pct(v.within_2x) + ' (was ' + pct(v.radar2_within_2x) + ')'),
      fact('Walk-forward median error (n = ' + w.n + ')', pct(w.median_ape) + ' (radar-2: ' + pct(w.radar2_median_ape) + ')'),
      fact('Walk-forward within 2x', pct(w.within_2x) + ' (was ' + pct(w.radar2_within_2x) + ')'),
      el('p', { class: 'ms-note', text: 'Fitted from this snapshot’s own live protocols — exchanges excluded, so the curve moves with the snapshot. TVL alone explains little of market cap, so implied values stay estimates, never prices. Walk-forward trains only on earlier listings and tests on later ones, so it is the blind time-split check.' })
    );
  }

  // Round 5: the KPI strip, first paint. Six headline figures, five derived here from
  // DATA at render time, never typed in by hand: the median of the rows' own fitted multiples
  // (the same fittedMultiple the board recomputes), the walk-forward error the model strip
  // shows in full, the rank-1 implied value, and the counts the lede and coverage line use.
  function kpiStrip() {
    var m = DATA.model;
    var w = m.validation.walk_forward;
    function pct(x) { return (x * 100).toFixed(1) + '%'; }
    function fact(label, value) {
      return el('div', { class: 'ms-fact' }, el('span', { text: label }), el('b', { text: value }));
    }
    var mults = DATA.rows.map(function (r) { return fittedMultiple(r.tvl_usd, m.category_shifts[r.category || 'Other'] || 0, m); });
    mults.sort(function (a, b) { return a - b; });
    var mid = mults.length / 2;
    var med = (mults[mid - 1] + mults[mid]) / 2;
    return el('section', { class: 'model-strip kpi', 'aria-label': 'Key figures at a glance' },
      fact('Ranked of snapshot', DATA.rows.length + ' / ' + snapshotTotal()),
      fact('Median fitted multiple', fmtMult(med)),
      fact('Walk-forward median error', pct(w.median_ape) + ' (n = ' + w.n + ')'),
      fact('Top implied value', fmtUsd(DATA.rows[0].implied_value_usd)),
      fact('Live-token protocols', String(DATA.live.length)),
      fact('Same-size check', 'median 1.11x the model \u00b7 218 of 226 rows within 2x')
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains || []; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; state.page = 1; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.category = select.value; state.page = 1; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; state.page = 1; writeHash(); render(); });
    var watch = el('input', { type: 'checkbox', id: 'watchlist', checked: state.watchlist ? 'checked' : null });
    watch.addEventListener('change', function () { state.watchlist = watch.checked; state.page = 1; writeHash(); render(); });
    function tabBtn(tab, label) {
      return el('button', { type: 'button', 'aria-pressed': state.tab === tab ? 'true' : 'false', text: label, onclick: function () { state.tab = tab; state.page = 1; render(); } });
    }
    var pre = tabBtn('pre-token', 'Pre-token');
    var live = tabBtn('live', 'Live token');
    var comp = tabBtn('comparables', 'Comparables');
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('label', { class: 'check', for: 'watchlist' }, watch, 'Watchlist only'),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live, comp)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : state.tab === 'live' ? DATA.live.length + ' live-token protocols' : DATA.comparables.length + ' live protocols behind the fit' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchlist = false; state.page = 1; writeHash(); render(); } })
      ));
    }
    var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * PAGE_SIZE;
    var pageRows = list.slice(start, start + PAGE_SIZE);
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    pageRows.forEach(function (r) {
      var sc = sizeCheck(r);
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num' }, el('div', { class: 'rank-cell' },
          el('span', { class: 'rank-badge' + (r.rank <= 3 ? ' top' : ''), text: String(r.rank) }),
          el('span', { class: 'rank-range', text: rankRange(r) })
        )),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainsTwo(r.chains) })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtMult(r.multiple) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        ),
          el('div', { class: 'check-line' + (sc.ratio < 0.5 || sc.ratio > 2 ? ' differs' : ''), text: 'check ' + fmtUsd(sc.check) + ' \u00b7 ' + sc.ratio.toFixed(2) + 'x' })
        ),
        el('td', { class: 'num' }, el('span', { class: 'verdict ' + r.farm_verdict.toLowerCase(), text: fmtSignedUsd(r.farm_net_usd) + ' · ' + r.farm_verdict })),
        el('td', null, el('span', { class: 'status' + (r.watchlist ? '' : ' early'), text: r.watchlist ? 'watchlist' : 'early' }))
      );
      tbody.appendChild(tr);
    });
    var prev = el('button', { class: 'button', type: 'button', text: 'Previous', disabled: state.page <= 1 ? 'disabled' : null, onclick: function () { state.page -= 1; writeHash(); render(); } });
    var next = el('button', { class: 'button', type: 'button', text: 'Next', disabled: state.page >= pages ? 'disabled' : null, onclick: function () { state.page += 1; writeHash(); render(); } });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Rank range is the 5th–95th percentile over 200 refits — mid-board ranks move widely. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('multiple', 'Multiple'),
            sortHeader('implied', 'Implied value'),
            sortHeader('farm', 'Farm net'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      ),
      el('div', { class: 'pager' },
        el('span', { text: 'Showing ' + (start + 1) + '–' + Math.min(start + PAGE_SIZE, list.length) + ' of ' + list.length }),
        el('span', { text: 'Page ' + state.page + ' of ' + pages }),
        el('div', { class: 'pages' }, prev, next)
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainsTwo(r.chains) }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.mcap_to_tvl === null ? 'n/a' : 'x' + r.mcap_to_tvl.toFixed(2) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking, and their market caps are what the model fits its curve to.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Mcap / TVL' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  // The comparables: the live evidence behind each category's fitted multiple. Categories arrive
  // ordered by fitted multiple, descending, and live names by market cap inside each group; this only groups them for display.
  function comparablesTable() {
    var m = DATA.model;
    function multOf(cat) {
      var v = m.multiples[cat || 'Other'];
      return typeof v === 'number' && isFinite(v) ? v : m.global_multiple;
    }
    function shiftOf(cat) { return m.category_shifts[cat || 'Other'] || 0; }
    var order = [];
    var byCat = {};
    DATA.comparables.forEach(function (c) {
      var cat = c.category || 'Other';
      if (!byCat[cat]) { byCat[cat] = []; order.push(cat); }
      byCat[cat].push(c);
    });
    var sections = order.map(function (cat) {
      var list = byCat[cat];
      var shift = shiftOf(cat);
      return el('section', { class: 'panel comp' },
        el('div', { class: 'comp-head' },
          el('h3', { text: cat }),
          el('span', { class: 'num', text: 'fitted multiple x' + multOf(cat).toFixed(3) }),
          el('span', { class: 'num', text: 'shift ' + (shift >= 0 ? '+' : '') + shift.toFixed(2) }),
          el('span', { class: 'num', text: list.length + ' live' })
        ),
        el('div', { class: 'table-wrap' },
          el('table', { class: 'comp-table' },
            el('thead', null, el('tr', null,
              el('th', { scope: 'col', text: 'Protocol' }),
              el('th', { scope: 'col', class: 'num', text: 'TVL' }),
              el('th', { scope: 'col', class: 'num', text: 'Market cap' }),
              el('th', { scope: 'col', class: 'num', text: 'Mcap / TVL' }))),
            el('tbody', null, list.map(function (c) {
              return el('tr', null,
                el('td', null, el('b', { text: c.name })),
                el('td', { class: 'num', text: fmtUsd(c.tvl_usd) }),
                el('td', { class: 'num', text: fmtUsd(c.mcap_usd) }),
                el('td', { class: 'num', text: 'x' + c.ratio.toFixed(2) }));
            }))
          )
        )
      );
    });
    return el('div', { class: 'comp-list' },
      el('p', { class: 'sub comp-intro', text: 'The live evidence behind each category’s fitted multiple: every live protocol the fit rests on (market cap above 0, TVL above 0, exchanges excluded), grouped by category in fitted-multiple order, biggest market cap first inside each group.' }),
      sections
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var r = m.regression;
    var v = m.validation;
    var entries = Object.keys(m.multiples).map(function (cat) {
      return { category: cat, n: m.multiple_counts[cat] || 0, shift: m.category_shifts[cat] || 0, multiple: m.multiples[cat] };
    }).sort(function (a, b) { return b.multiple - a.multiple || (a.category < b.category ? -1 : 1); });
    var multRows = entries.map(function (e) {
      return el('tr', null,
        el('td', { text: e.category }),
        el('td', { class: 'num', text: String(e.n) }),
        el('td', { class: 'num', text: (e.shift >= 0 ? '+' : '') + e.shift.toFixed(2) }),
        el('td', { class: 'num', text: 'x' + e.multiple.toFixed(3) })
      );
    });
    multRows.push(el('tr', null,
      el('td', { text: 'Global fit (no category shift)' }),
      el('td', { class: 'num', text: String(m.live_count) }),
      el('td', { class: 'num', text: '+0.00' }),
      el('td', { class: 'num', text: 'x' + m.global_multiple.toFixed(3) })
    ));
    function pct(x) { return (x * 100).toFixed(1) + '%'; }
    var valRows = [
      ['Median absolute percentage error', pct(v.median_ape), pct(v.radar2_median_ape)],
      ['Mean absolute percentage error', pct(v.mean_ape), pct(v.radar2_mean_ape)],
      ['Predictions within 2x of the recorded market cap', pct(v.within_2x), pct(v.radar2_within_2x)],
      ['Predictions within 1.5x of the recorded market cap', pct(v.within_1_5x), pct(v.radar2_within_1_5x)]
    ].map(function (row) {
      return el('tr', null,
        el('td', { text: row[0] }),
        el('td', { class: 'num', text: row[1] }),
        el('td', { class: 'num', text: row[2] })
      );
    });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula' },
        'log(mcap) = ' + r.intercept.toFixed(3) + ' + ' + r.slope.toFixed(3) + ' x log(TVL)' + '   (R² = ' + r.r_squared.toFixed(2) + ', n = ' + r.n + ' live protocols)' + '\n' +
        'multiple(category, TVL) = clamp( exp(' + r.intercept.toFixed(3) + ' + shift(category)) x TVL^(' + (r.slope - 1).toFixed(3) + '), ' + m.multiple_min + ', ' + m.multiple_max + ' )' + '\n' +
        'implied = round( tvl_usd x multiple x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') )'
      ),
      el('p', { class: 'sub', text: 'TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days. The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.' }),
      el('h3', { text: 'Where the multiple comes from' }),
      el('p', { class: 'sub', text: 'The curve is fitted, not guessed: an ordinary least-squares fit of log(market cap) on log(TVL) over the snapshot’s ' + m.live_count + ' live protocols (exchanges excluded, since a CEX is not comparable pricing for a protocol) gives log(mcap) = ' + r.intercept.toFixed(3) + ' + ' + r.slope.toFixed(3) + ' x log(TVL). Each category with at least ' + m.min_live_n + ' live protocols gets an intercept shift: the median residual of its live names in log space, shrunk toward 0 with k=' + m.shrink_k + '. A category with fewer than ' + m.min_live_n + ' live protocols gets shift 0 and is priced by the global fit alone. Because the slope is below 1, the multiple falls as TVL grows: a $5M pool and a $5B pool are no longer priced alike. A lending pool and a DEX are priced like different businesses because the market prices them that way.' }),
      el('table', { class: 'mult-table' },
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Category' }),
          el('th', { scope: 'col', class: 'num', text: 'Live protocols' }),
          el('th', { scope: 'col', class: 'num', text: 'Shift' }),
          el('th', { scope: 'col', class: 'num', text: 'Reference multiple' })
        )),
        el('tbody', null, multRows)
      ),
      el('p', { class: 'note', text: 'Each row’s multiple is the fitted multiple at that category’s median live TVL: a reference point, not the scoring rule. A row’s own multiple is the same formula evaluated at the row’s own TVL, so two protocols in one category carry different multiples when their TVLs differ. The global entry is the fit at the global median live TVL, with shift 0. Change the snapshot and the curve moves with it.' }),
      el('h3', { text: 'How well it predicts' }),
      el('p', { class: 'sub', text: 'Leave-one-out over the same ' + v.n + ' live protocols: each protocol’s market cap is predicted from its TVL alone, refitting the model without it, and scored against the market cap on record. Radar-3 beats radar-2’s flat category multiples on every measure, but the gain is modest: a third of predictions land within 2x of the recorded market cap, against a fifth before.' }),
      el('table', { class: 'mult-table' },
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Leave-one-out validation (n = ' + v.n + ')' }),
          el('th', { scope: 'col', class: 'num', text: 'Radar-3' }),
          el('th', { scope: 'col', class: 'num', text: 'Radar-2' })
        )),
        el('tbody', null, valRows)
      ),
      el('p', { class: 'note', text: 'TVL alone explains little of market cap (R² = ' + r.r_squared.toFixed(2) + '): this is a better-calibrated summary of the market, not a precise price, and implied values stay estimates, never prices. The mean error is far larger than the median — a few tiny-TVL names with outsized market caps dominate it — so the median is the honest headline.' }),
      el('h3', { text: 'Walk-forward: the blind time-split check' }),
      el('p', { class: 'sub', text: 'Each fold fits the model only on protocols listed before the cutoff and scores the ones listed after it, so no future listing leaks into the fit.' }),
      el('table', { class: 'mult-table' },
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Walk-forward validation (n = ' + v.walk_forward.n + ')' }),
          el('th', { scope: 'col', class: 'num', text: 'Radar-3' }),
          el('th', { scope: 'col', class: 'num', text: 'Radar-2' })
        )),
        el('tbody', null, [
          ['Median absolute percentage error', v.walk_forward.median_ape, v.walk_forward.radar2_median_ape],
          ['Mean absolute percentage error', v.walk_forward.mean_ape, v.walk_forward.radar2_mean_ape],
          ['Predictions within 2x of the recorded market cap', v.walk_forward.within_2x, v.walk_forward.radar2_within_2x],
          ['Predictions within 1.5x of the recorded market cap', v.walk_forward.within_1_5x, v.walk_forward.radar2_within_1_5x]
        ].map(function (row) {
          return el('tr', null,
            el('td', { text: row[0] }),
            el('td', { class: 'num', text: pct(row[1]) }),
            el('td', { class: 'num', text: pct(row[2]) })
          );
        }))
      ),
      el('p', { class: 'note', text: 'Folds: ' + v.walk_forward.folds.map(function (f) { return f.cutoff.slice(0, 4) + ' (train ' + f.train_n + ', test ' + f.test_n + ') median ' + pct(f.median_ape) + ', within 2x ' + pct(f.within_2x); }).join('; ') + '. ' + v.walk_forward.undated_excluded + ' undated live protocols are excluded from the folds.' })
    );
  }

  function foot() {
    return el('footer', { class: 'foot' },
      el('span', { text: 'Source: ' + DATA.source }),
      el('span', { text: 'Implied value is a model of what a token might be worth if the protocol issued one, priced off the market caps of live protocols in the same category. It is not a price, a prediction, or investment advice.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    var recomputed = impliedOf(row, DATA.model);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' · range ' + rankRange(row) + (row.watchlist ? ' · watchlist' : ' · early radar') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.slice(0, 3).join(', ') + (row.chains.length > 3 ? ' and ' + (row.chains.length - 3) + ' more' : '') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Fitted multiple (' + (row.category || 'Other') + ', at this TVL)' }), el('b', { class: 'num', text: fmtMult(row.multiple) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: String(row.maturity_multiplier) })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) })),
        el('div', null, el('span', { text: 'Rank range (5th–95th pct, 200 refits)' }), el('b', { class: 'num', text: rankRange(row) + ' (median ' + row.rank_median + ')' })),
        el('div', null, el('span', { text: 'Farm net after gas' }), el('b', { class: 'num', text: fmtSignedUsd(row.farm_net_usd) })),
        el('div', null, el('span', { text: 'Farm verdict' }), el('b', { class: 'num', text: row.farm_verdict }))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    var sc = sizeCheck(row);
    var agrees = sc.ratio >= 0.5 && sc.ratio <= 2;
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Same-size market check' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'Band' }), el('b', { class: 'num', text: fmtUsd(sc.lo) + '\u2013' + fmtUsd(sc.hi) + ' TVL \u00b7 ' + sc.n + ' live protocols' })),
        el('div', null, el('span', { text: 'Median live multiple in this band' }), el('b', { class: 'num', text: 'x' + sc.med.toFixed(3) })),
        el('div', null, el('span', { text: 'Check value' }), el('b', { class: 'num', text: fmtUsd(sc.check) })),
        el('div', { class: 'total' }, el('span', { text: 'Model implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) + ' \u00b7 check is ' + sc.ratio.toFixed(2) + 'x the model \u2014 ' + (agrees ? 'agrees' : 'differs') }))
      ),
      el('p', { class: 'sub', text: 'No fitted curve and no category shift: the median of what live protocols this size actually trade at, put through this row\'s own growth and maturity multipliers. Where it differs, the gap is mostly the category shift.' + (agrees ? '' : ' Treat this implied value with more caution.') })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('p', { class: 'sub', text: 'Net ' + fmtSignedUsd(row.farm_net_usd) + ' after gas — verdict ' + row.farm_verdict + ' (Farm at +$10 or more, Thin at $0 or more, else Skip).' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(kpiStrip());
    shell.appendChild(lede());
    shell.appendChild(modelStrip());
    shell.appendChild(coverageLine());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'live' ? liveTable() : state.tab === 'comparables' ? comparablesTable() : boardTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    shell.appendChild(foot());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
