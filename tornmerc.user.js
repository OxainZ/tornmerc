// ==UserScript==
// @name         Torn Merc Radar
// @version      0.8.0
// @description  Free merc radar: watches your contracts, Torn's bounty board and paid-hit factions through the Torn API and alerts you the moment a target can be hit. Fair Fight on every target (FFScouter), chain kit, attack-page contract check, hit log. Alerts only; every attack stays manual.
// @author       Oxain
// @match        https://www.torn.com/*
// @run-at       document-idle
// @noframes
// @downloadURL  https://raw.githubusercontent.com/OxainZ/tornmerc/main/tornmerc.user.js
// @updateURL    https://raw.githubusercontent.com/OxainZ/tornmerc/main/tornmerc.meta.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      api.torn.com
// @connect      ffscouter.com
// ==/UserScript==

(function () {
	'use strict';

	/* ---------- pure core (exported for Node, no DOM) ---------- */

	const Merc = {};
	Merc.VERSION = '0.8.0';
	Merc.API = 'https://api.torn.com/v2';
	Merc.FF_API = 'https://ffscouter.com/api/v1';
	Merc.COMMENT = 'TornMerc';
	Merc.BUDGET_PER_MIN = 75;       // Torn allows 100 a minute across all of a player's keys; leave room for other scripts
	Merc.TICK_MS = 1000;
	Merc.MAX_ROWS = 60;
	Merc.MAX_BOUNTY_WATCH = 60;     // best-paying bounty targets polled individually; deep-hospital ones cost one call per 5 min
	Merc.BOUNTY_PAGE = 100;         // /torn/bounties serves 100 a page; _metadata.total says how many pages the board needs
	Merc.BOUNTY_MAX_PAGES = 10;
	Merc.ENERGY_PER_HIT = 25;
	Merc.BOUNTY_BLACKLIST_H = 24;   // a bounty you ticked as collected stays hidden this long, or until the board changes for that target
	Merc.SOON_WARN_SEC = 30;        // "get on the attack page": a bounty target leaves hospital this soon
	Merc.POOL_REFRESH_SEC = 300;    // FFScouter get-targets allows 25 calls a minute per IP; we use one every 5 minutes
	Merc.STATS_REFRESH_SEC = 600;   // FFScouter get-stats: one call per 10 minutes covers every row (205 ids a call)
	Merc.STATS_BATCH = 205;
	Merc.CHAIN_WARN_SEC = 90;       // chain timer alert, once per drop
	Merc.LOG_MAX = 100;
	Merc.LOCK_TTL_MS = 5000;
	Merc.ALLOWED = [3843323, 4449883];              // Torn ids this radar runs for; empty = nobody. Add with: node tools/allow.js <id>, then release.
	Merc.OWNER = 'Oxain';
	Merc.RULES = [
		['any', 'Any activity'], ['online', 'Online now'], ['active', 'Online or idle (traders)'],
		['within:2', 'Active in last 2 min'], ['within:5', 'Active in last 5 min'], ['within:10', 'Active in last 10 min'],
		['within:15', 'Active in last 15 min'], ['within:30', 'Active in last 30 min'], ['within:60', 'Active in last 60 min'],
		['idle:15', 'Inactive 15+ min'], ['idle:30', 'Inactive 30+ min'], ['idle:60', 'Inactive 60+ min'], ['idle:360', 'Inactive 6+ hours'],
	];

	/** "123, 456 789" -> [123, 456, 789]: positive ids only, no repeats, order kept. */
	Merc.parseIds = function (text) {
		const out = [];
		for (const part of String(text || '').split(/[\s,;]+/)) {
			const n = Number(part);
			if (part && Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
		}
		return out;
	};

	/**
	 * The country a Torn status puts a player in, or null if they are not hittable anywhere.
	 * Okay = in Torn. Abroad = "In Japan". Hospital, Jail, Federal, Traveling and the rest = null.
	 */
	Merc.countryOf = function (status) {
		if (!status) return null;
		if (status.state === 'Okay') return 'Torn';
		if (status.state === 'Abroad') {
			const m = /^In (?:the )?(.+?)\.?$/i.exec(String(status.description || '').trim());
			return m ? m[1] : null;
		}
		return null;
	};

	/** Does this last_action satisfy the rule? `nowSec` is unix seconds. */
	Merc.activityOk = function (rule, lastAction, nowSec) {
		const [type, n] = String(rule || 'any').split(':');
		if (type === 'any') return true;
		const la = lastAction || {};
		const idleSec = la.timestamp ? nowSec - la.timestamp : Infinity;
		if (type === 'online') return la.status === 'Online';
		if (type === 'active') return la.status === 'Online' || la.status === 'Idle';
		if (type === 'within') return la.status === 'Online' || idleSec <= Number(n) * 60;
		if (type === 'idle') return la.status !== 'Online' && idleSec >= Number(n) * 60;
		return false;
	};

	/**
	 * Can this player be hit right now under the contract's terms?
	 * player: {status, last_action, has_early_discharge}; watch: {rule, noED, factionId}; myCountry: where I am.
	 * Returns {state: 'hit'|'soon'|'no', why, until}.
	 */
	Merc.evaluate = function (player, watch, myCountry, nowSec, myFaction) {
		const st = (player && player.status) || {};
		const until = Number(st.until) || 0;
		if (myFaction && player && Number(player.faction_id) === myFaction) return { state: 'no', why: 'own faction', until };   // Torn does not let you attack faction mates
		if (st.state === 'Hospital' || st.state === 'Jail') return { state: 'soon', why: st.state.toLowerCase(), until };
		if (st.state === 'Traveling') return { state: 'no', why: 'flying', until };
		const there = Merc.countryOf(st);
		if (!there) return { state: 'no', why: String(st.state || 'unknown').toLowerCase(), until };
		if (myCountry && there.toLowerCase() !== myCountry.toLowerCase()) return { state: 'no', why: `in ${there}`, until };
		if (watch.noED && watch.factionId && player.has_early_discharge === undefined) return { state: 'no', why: 'checking early discharge', until };   // a profile has no such field; the faction list does
		if (watch.noED && player.has_early_discharge) return { state: 'no', why: 'has early discharge', until };
		if (!Merc.activityOk(watch.rule, player.last_action, nowSec)) return { state: 'no', why: 'activity rule', until };
		return { state: 'hit', why: 'hit now', until };
	};

	/**
	 * The Fair Fight gate: a hittable target whose FF is above my limit is DANGER, not a hit.
	 * FFScouter: FF = 1 + 8/3 x (their stats / mine); 2 = easy, 3.67 = equal, above that they out-stat me.
	 * ff = FFScouter's fair_fight for me (0 = unknown). An unknown FF passes only when the limit is off.
	 */
	Merc.ffGate = function (r, ff, maxFf) {
		if (r.state !== 'hit' || !maxFf) return r;
		if (!ff) return { ...r, state: 'no', why: 'FF unknown' };
		if (ff > maxFf) return { ...r, state: 'no', why: `DANGER FF ${ff.toFixed(2)}` };
		return r;
	};

	/** FFScouter get-stats for up to 205 ids. */
	Merc.statsUrl = function (ffKey, ids) {
		return `${Merc.FF_API}/get-stats?key=${encodeURIComponent(ffKey)}&targets=${ids.slice(0, Merc.STATS_BATCH).map(Number).join(',')}`;
	};

	/** id -> {ff, bs} from a get-stats response (array or {targets}/{results} object). */
	Merc.parseStats = function (json) {
		const out = new Map();
		const list = Array.isArray(json) ? json : (json && (json.targets || json.results || json.stats)) || [];
		for (const t of list) {
			const id = Number(t.player_id || t.id);
			if (id) out.set(id, { ff: Number(t.fair_fight) || 0, bs: String(t.bs_estimate_human || '') });
		}
		return out;
	};

	/** Which ids still need a stat lookup: unknown, or older than the refresh. */
	Merc.staleStatIds = function (ids, statsAt, nowMs) {
		return [...new Set(ids)].filter((id) => !statsAt.has(id) || nowMs - statsAt.get(id) > Merc.STATS_REFRESH_SEC * 1000);
	};

	/** The chain alert fires once when the timer first drops under the limit, and re-arms once it is back above. */
	Merc.chainAlert = function (chain, warnSec, armed) {
		const live = chain && chain.current > 0 && chain.timeout > 0;
		if (!live || chain.timeout > warnSec) return { alert: false, armed: true };
		return { alert: armed, armed: false };
	};

	/**
	 * Bounties worth watching. One entry per target, every live bounty on them stacked.
	 * One hospitalisation claims ONE bounty, the highest on the target (Torn pays the rest on later hits,
	 * after they leave hospital again), so the money that matters is `perHit`; `total` is the whole pile
	 * and `more` what is left for follow-up hits. A quantity-N bounty is N claims of `reward`.
	 * Filters: not me, not listed by me, expired, level cap, reward floor (per hit), FF cap (when known),
	 * the collected list (hidden while the board still shows the same pile).
	 * Each becomes a watch {id, rule:'any', bounty:{perHit, total, more, hits, count, lister, expires, sig}}.
	 * opts: {myId, maxLevel, minReward, maxFf, stats: Map id->{ff}, skip: Map id->{at, sig}, max, now}
	 */
	Merc.bountyWatches = function (bounties, opts) {
		const o = opts || {};
		const best = new Map();
		for (const b of bounties || []) {
			const id = Number(b.target_id);
			if (!id || id === o.myId || Number(b.lister_id) === o.myId) continue;
			if (o.now && Number(b.valid_until) && Number(b.valid_until) < o.now) continue;   // a page from the cache can still list an expired bounty
			if (o.maxLevel && Number(b.target_level) > o.maxLevel) continue;
			const reward = Number(b.reward) || 0;
			const qty = Math.max(1, Number(b.quantity) || 1);
			const st = o.stats && o.stats.get(id);
			if (o.maxFf && st && st.ff > o.maxFf) continue;
			const cur = best.get(id) || { id, rule: 'any', noED: false, level: Number(b.target_level) || 0, name: b.target_name, bounty: { perHit: 0, total: 0, more: 0, hits: 0, count: 0, lister: '', expires: 0, sig: '' } };
			cur.bounty.total += reward * qty;
			cur.bounty.hits += qty;
			cur.bounty.count += 1;
			if (reward > cur.bounty.perHit) { cur.bounty.perHit = reward; cur.bounty.lister = b.lister_name || 'anonymous'; }
			cur.bounty.expires = Math.max(cur.bounty.expires, Number(b.valid_until) || 0);
			best.set(id, cur);
		}
		const out = [];
		for (const w of best.values()) {
			w.bounty.more = w.bounty.total - w.bounty.perHit;
			w.bounty.sig = `${w.bounty.perHit}:${w.bounty.hits}`;
			if (o.minReward && w.bounty.perHit < o.minReward) continue;
			const skipped = o.skip && o.skip.get(w.id);
			if (skipped && skipped.sig === w.bounty.sig) continue;   // still the pile you collected from; a new or claimed bounty changes it and brings the target back
			out.push(w);
		}
		return out.sort((a, b) => b.bounty.perHit - a.bounty.perHit || b.bounty.total - a.bounty.total || a.level - b.level).slice(0, o.max || Merc.MAX_BOUNTY_WATCH);
	};

	/** How many board pages to read: _metadata.total over 100 a page, at least one, capped. */
	Merc.boardPages = function (total) {
		return Math.min(Merc.BOUNTY_MAX_PAGES, Math.max(1, Math.ceil((Number(total) || 0) / Merc.BOUNTY_PAGE)));
	};

	/**
	 * Bounty order: OUT NOW first (most cash per hit first), then whoever is out soonest.
	 * Inside the same minute of release, more cash wins; so two targets out at 9:40 and 10:10 are a coin
	 * flip on the clock and the bigger bounty is listed first. Above my FF limit = not listed at all.
	 * Returns {bucket, cash}: bucket 0 = out now, else the minute of release; sort ascending bucket, descending cash.
	 */
	Merc.bountyKey = function (row, nowSec) {
		const b = row.bounty;
		if (!b || row.state === 'no') return null;
		if (row.state === 'hit') return { bucket: 0, cash: b.perHit };
		const waitMin = Math.max(0, (row.until || 0) - nowSec) / 60;
		return { bucket: 1 + Math.floor(waitMin), cash: b.perHit };
	};

	/** Who put them in hospital last, from the status details ("Hospitalized by Bob"), or '' (overdose, self-hosp, unknown). */
	Merc.hospitalizedBy = function (status) {
		const m = /^Hospitali[sz]ed by (.+?)\.?$/i.exec(String((status && status.details) || '').replace(/<[^>]*>/g, '').trim());
		return m ? m[1] : '';
	};

	/** Keeps the second a target was first seen out (Okay or Abroad); forgets it once they are not. */
	Merc.trackOut = function (outSince, id, status, nowSec) {
		if (Merc.countryOf(status)) { if (!outSince.has(id)) outSince.set(id, nowSec); } else outSince.delete(id);
		return outSince;
	};

	/** Hits my energy pays for. */
	Merc.hitsAffordable = function (bars) {
		return bars && bars.energy ? Math.floor((Number(bars.energy.current) || 0) / Merc.ENERGY_PER_HIT) : null;
	};

	Merc.money = function (n) {
		n = Number(n) || 0;
		if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}b`;
		if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}m`;
		if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
		return `$${n}`;
	};

	/** Bounty rows: out now (most cash first), then soonest out; the unreachable dropped. */
	Merc.rankBounties = function (rows, nowSec) {
		return rows.map((r) => ({ ...r, order: Merc.bountyKey(r, nowSec) })).filter((r) => r.order)
			.sort((a, b) => a.order.bucket - b.order.bucket || b.order.cash - a.order.cash || a.level - b.level);
	};

	/** Collected list: id -> {at, sig} ticked within the window, so a bounty you already collected is not re-listed. */
	Merc.pruneSkip = function (skip, nowSec) {
		const out = new Map();
		for (const [id, v] of skip || []) if (v && typeof v === 'object' && nowSec - v.at < Merc.BOUNTY_BLACKLIST_H * 3600) out.set(id, v);
		return out;
	};

	/** The API sources the watches need. A no-ED target with a known faction reads that faction's list. */
	Merc.sources = function (watches, factions) {
		const map = new Map();
		const add = (key, path) => { if (!map.has(key)) map.set(key, { key, path }); };
		for (const f of factions || []) add(`f${f.id}`, `/faction/${f.id}/members`);
		for (const w of watches || []) {
			if (w.noED && w.factionId) add(`f${w.factionId}`, `/faction/${w.factionId}/members`);
			else add(`u${w.id}`, `/user/${w.id}/profile`);
		}
		return [...map.values()];
	};

	/**
	 * Seconds between polls: the last minute of a hospital stay is polled every 2 s, the last five every 15 s,
	 * the last half hour every minute, and a long stay every 5 min (a revive can let them out early).
	 * Out targets every 30 s, a flight every 2 min. The budget goes where the money is about to be.
	 */
	Merc.pollSeconds = function (players, nowSec) {
		let best = 600;
		for (const p of players || []) {
			const st = (p && p.status) || {};
			const left = (Number(st.until) || 0) - nowSec;
			let s = 60;
			if (st.state === 'Hospital' || st.state === 'Jail') s = left <= 60 ? 2 : left <= 300 ? 15 : left <= 1800 ? 60 : 300;
			else if (st.state === 'Okay' || st.state === 'Abroad') s = 30;
			else if (st.state === 'Traveling') s = 120;
			best = Math.min(best, s);
		}
		return players && players.length ? best : 60;
	};

	/**
	 * The source that is most overdue relative to its own period, or null if nothing is due or the budget is
	 * spent. A 2-second poll four seconds late beats a 5-minute poll a minute late, so the release-second
	 * polls are never starved by a long watch list. period: key -> ms between polls (60 s when unknown).
	 */
	Merc.nextDue = function (sources, dueAt, nowMs, remaining, period) {
		if (remaining <= 0) return null;
		let pick = null;
		let late = -1;
		for (const s of sources) {
			const due = dueAt[s.key] || 0;
			if (due > nowMs) continue;
			const ratio = (nowMs - due) / ((period && period[s.key]) || 60000);
			if (ratio > late) { late = ratio; pick = s; }
		}
		return pick;
	};

	/**
	 * Rows about to leave hospital: a bounty target inside `leadSec` of release that has not been warned yet.
	 * Returns {alerts, warned}; keep `warned` for the next call so each release warns once.
	 */
	Merc.newlySoon = function (rows, warned, nowSec, leadSec) {
		const next = new Set();
		const alerts = [];
		for (const r of rows) {
			const left = (r.until || 0) - nowSec;
			if (r.state !== 'soon' || !r.bounty || left <= 0 || left > leadSec) continue;
			next.add(r.key);
			if (!warned.has(r.key)) alerts.push(r);
		}
		return { alerts, warned: next };
	};

	/** Sliding one-minute request budget. */
	Merc.makeBudget = function (limit) {
		let stamps = [];
		const trim = (now) => { stamps = stamps.filter((t) => now - t < 60000); };
		return {
			hit(now) { trim(now); stamps.push(now); },
			remaining(now) { trim(now); return limit - stamps.length; },
		};
	};

	/** Rows that just became hittable. `prev` is a Set of keys that were hittable last time. */
	Merc.newlyHit = function (rows, prev) {
		return rows.filter((r) => r.state === 'hit' && !prev.has(r.key));
	};

	/** The gate: the radar runs only for a key owner whose Torn id is on the list. Fails closed on an empty list or an unknown id. */
	Merc.allowed = function (id, list) {
		const n = Number(id);
		return Number.isSafeInteger(n) && n > 0 && (list || Merc.ALLOWED).map(Number).includes(n);
	};

	/** The line a locked-out player sees: their own id, so they can ask for access. */
	Merc.deniedText = function (id) {
		return `This radar is private. Your Torn id is ${Number(id) || '?'}; ask ${Merc.OWNER} for access.`;
	};

	/** Who polls: the tab holding a fresh lock. lock = {tab, at}. */
	Merc.ownsLock = function (lock, tabId, nowMs) {
		return !lock || lock.tab === tabId || nowMs - lock.at > Merc.LOCK_TTL_MS;
	};

	Merc.url = function (path, key, fresh) {
		return `${Merc.API}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}&comment=${Merc.COMMENT}${fresh ? `&timestamp=${fresh}` : ''}`;
	};

	/** FFScouter get-targets: level range, fair fight 1.0..maxFf, inactive 14+ days, up to 50. */
	Merc.poolUrl = function (ffKey, opts) {
		const o = opts || {};
		const q = new URLSearchParams({ key: ffKey, minlevel: String(o.minLevel || 1), maxlevel: String(o.maxLevel || 100), minff: '1', maxff: String(o.maxFf || 3), inactiveonly: '1', limit: '50' });
		return `${Merc.FF_API}/get-targets?${q}`;
	};

	/** Pool rows from an FFScouter get-targets response: out of hospital now, lowest level first. */
	Merc.poolRows = function (json, nowSec) {
		const rows = [];
		for (const t of (json && json.targets) || []) {
			const id = Number(t.player_id);
			if (!id) continue;
			const hosp = Number(t.hospital_until) || 0;
			rows.push({ key: `pool${id}`, id, name: String(t.name || id), level: Number(t.level) || 0, ff: Number(t.fair_fight) || 0, bs: String(t.bs_estimate_human || ''), state: hosp > nowSec ? 'soon' : 'hit', why: hosp > nowSec ? 'hospital' : 'inactive 14d+', until: hosp, label: 'chain pool' });
		}
		return rows.sort((a, b) => (a.state === 'hit' ? 0 : 1) - (b.state === 'hit' ? 0 : 1) || a.level - b.level);
	};

	/** A Torn API error as {code, text, fatal}, or null. Fatal errors stop the radar; others skip one source. */
	Merc.apiError = function (json) {
		const e = json && json.error;
		if (!e) return null;
		const code = Number(e.code);
		const known = { 2: 'API key is wrong', 5: 'Rate limit hit, wait a minute', 8: 'Your IP is temporarily blocked by the API', 10: 'Key owner is in federal jail', 13: 'Key disabled for inactivity', 14: 'Key read-limit reached', 16: 'Key access level is too low', 18: 'API key is paused' };
		return { code, text: known[code] || String(e.error || `API error ${code}`), fatal: code in known };
	};

	/** The only game URLs this script produces, as plain links for you to click. Opening one attacks nobody. */
	Merc.attackUrl = function (id) { return `https://www.torn.com/page.php?sid=attack&user2ID=${Number(id)}`; };   // loader.php?sid=attack was retired by Torn (it now answers 'endpoint no longer available')
	Merc.profileUrl = function (id) { return `https://www.torn.com/profiles.php?XID=${Number(id)}`; };

	/** The target id of an attack page, from its path + query, or 0 elsewhere. */
	Merc.attackPageTarget = function (pathname, search) {
		if (!/\/(?:page|loader)\.php$/.test(pathname || '')) return 0;   // page.php is Torn's attack page now; loader.php links still exist in old sidebars
		const q = new URLSearchParams(search || '');
		return q.get('sid') === 'attack' ? Number(q.get('user2ID')) || 0 : 0;
	};

	/** One hit-log line the merc can paste as proof: who, when (TCT), their state when they cleared. */
	Merc.logEntry = function (row, player, watch, nowSec) {
		const la = (player && player.last_action) || {};
		const idle = la.timestamp ? Math.floor((nowSec - la.timestamp) / 60) : null;
		const ed = player && player.has_early_discharge === undefined ? 'ED unknown' : player && player.has_early_discharge ? 'HAS ED' : 'no ED';
		const terms = (Merc.RULES.find(([v]) => v === (watch && watch.rule)) || ['', 'any'])[1];
		return { at: nowSec, id: row.id, name: row.name, level: row.level, text: `${row.name} [${row.id}] lvl ${row.level} cleared ${Merc.tct(nowSec)} TCT: ${(player && player.status && player.status.description) || 'Okay'}, ${la.status || 'activity unknown'}${idle === null ? '' : ` ${idle}m ago`}, ${ed}. Terms: ${terms}${watch && watch.note ? ` (${watch.note})` : ''}` };
	};

	Merc.tct = function (sec) {
		const d = new Date(sec * 1000);
		return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
	};

	Merc.clock = function (seconds) {
		const s = Math.max(0, Math.floor(seconds));
		return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	};

	/** Display order: hittable, then nearest release, then lowest level. */
	Merc.sortRows = function (rows) {
		const rank = { hit: 0, soon: 1, no: 2 };
		return rows.slice().sort((a, b) => rank[a.state] - rank[b.state] || (a.until || Infinity) - (b.until || Infinity) || a.level - b.level);
	};

	/** The attack-page bar's text from my bars and the target's row (or null if unwatched). */
	Merc.barText = function (bars, row, nowSec) {
		const parts = [];
		if (bars) {
			parts.push(`E ${bars.energy.current}/${bars.energy.maximum}`);
			parts.push(`Life ${bars.life.current}/${bars.life.maximum}${bars.life.current < bars.life.maximum / 2 ? ' LOW' : ''}`);
		}
		if (!row) parts.push('Not on your radar');
		else if (row.state === 'hit' && row.bounty) parts.push(`${row.name}: HOSPITALIZE to claim ${Merc.money(row.bounty.perHit)}${row.bounty.more ? ` (+${Merc.money(row.bounty.more)} on later hits)` : ''}${row.ff ? ` · FF ${row.ff.toFixed(2)}` : ''}`);
		else if (row.state === 'hit') parts.push(`${row.name}: terms met${row.ff ? ` · FF ${row.ff.toFixed(2)}` : ''}`);
		else parts.push(`${row.name}: DO NOT HIT (${row.why}${row.state === 'soon' && row.until > nowSec ? ` ${Merc.clock(row.until - nowSec)}` : ''})`);
		return parts.join(' · ');
	};

	if (typeof module !== 'undefined' && module.exports) module.exports = Merc;
	if (typeof document === 'undefined') return;

	/* ---------- storage + http ---------- */

	const hasGM = typeof GM_getValue === 'function';
	const load = (k, d) => {
		try { return hasGM ? GM_getValue(k, d) : (localStorage.getItem('tornmerc.' + k) === null ? d : JSON.parse(localStorage.getItem('tornmerc.' + k))); } catch (e) { return d; }
	};
	const save = (k, v) => {
		try { if (hasGM) GM_setValue(k, v); else localStorage.setItem('tornmerc.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked: settings last this page only */ }
	};

	function getJson(url) {
		if (typeof GM_xmlhttpRequest === 'function') {
			return new Promise((resolve, reject) => GM_xmlhttpRequest({
				method: 'GET', url, timeout: 15000,
				onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error('bad response')); } },   // r is empty when TornPDA drops a repeat call
				onerror: () => reject(new Error('network error')),
				ontimeout: () => reject(new Error('timed out')),
			}));
		}
		if (typeof PDA_httpGet === 'function') return PDA_httpGet(url, {}).then((r) => { if (!r) throw new Error('repeat call dropped'); return JSON.parse(r.responseText); });
		return fetch(url).then((r) => r.json());
	}

	/* ---------- panel ---------- */

	const css = document.createElement('style');
	css.textContent = `
#tm-btn{position:fixed;left:8px;bottom:64px;z-index:99998;padding:6px 10px;border:1px solid #666;border-radius:6px;background:#222;color:#eee;font:bold 12px Arial,sans-serif;cursor:pointer}
#tm-btn.tm-live{background:#2f6b3a}
#tm-panel{position:fixed;left:8px;bottom:100px;z-index:99999;width:min(460px,calc(100vw - 16px));max-height:78vh;overflow:auto;box-sizing:border-box;padding:10px;border:1px solid #666;border-radius:8px;background:#1b1b1b;color:#ddd;font:12px Arial,sans-serif}
#tm-panel label{display:block;margin:6px 0 2px;color:#aaa}
#tm-panel input:not([type=checkbox]),#tm-panel select{box-sizing:border-box;width:100%;padding:4px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:#eee;font:12px Arial,sans-serif}
#tm-panel .tm-two{display:flex;gap:8px}#tm-panel .tm-two>div{flex:1;min-width:0}
#tm-panel button{margin:6px 4px 6px 0;padding:6px 10px;border:0;border-radius:4px;background:#3a6ea5;color:#fff;font:bold 12px Arial,sans-serif;cursor:pointer}
#tm-panel button.tm-x{margin:0;padding:0 5px;background:none;color:#999}
#tm-panel details{margin-top:6px}#tm-panel summary{cursor:pointer;color:#bbb}
#tm-panel table{width:100%;border-collapse:collapse}#tm-panel td{padding:4px 3px;border-top:1px solid #333}
#tm-panel a{color:#7db8f0}#tm-panel a.tm-hit{display:inline-block;padding:2px 8px;border-radius:4px;background:#a33;color:#fff;font-weight:bold;text-decoration:none}
#tm-panel tr.tm-state-hit td{background:#23351f}#tm-panel tr.tm-state-soon td{background:#33301c}#tm-panel tr.tm-danger td{background:#4a1f1f}
#tm-panel td.tm-group{padding-top:8px;color:#e6c35c;font-weight:bold;border-top:0}#tm-panel .tm-note{color:#999;font-size:11px;line-height:1.35}#tm-status{min-height:15px;margin:4px 0;color:#e6c35c}#tm-last{margin:4px 0;font-weight:bold}#tm-last:empty{display:none}
#tm-panel .tm-log div{padding:3px 0;border-top:1px solid #333;font-size:11px;word-break:break-word}
#tm-bar{position:fixed;top:0;left:0;right:0;z-index:99997;padding:6px 10px;background:#1b1b1b;color:#eee;font:bold 13px Arial,sans-serif;border-bottom:2px solid #666;text-align:center}
#tm-bar.tm-ok{border-color:#3c8c4a}#tm-bar.tm-bad{border-color:#c0392b;color:#ff9b8f}`;
	document.head.appendChild(css);

	function el(tag, props, ...kids) {
		const n = Object.assign(document.createElement(tag), props || {});
		for (const k of kids) n.append(k);
		return n;
	}
	function field(labelText, input) { return el('div', {}, el('label', { textContent: labelText }), input); }
	function ruleSelect() {
		const s = el('select', {});
		for (const [value, text] of Merc.RULES) s.append(el('option', { value, textContent: text }));
		return s;
	}

	let watches = load('watches', []);
	let factions = load('factions', []);
	let bountyWatches = [];
	let bountyRaw = [];           // all pages of the board, merged
	let bountyTotal = 0;          // how many bounties the board holds (_metadata.total), so every page is read
	let bountySkip = new Map(load('bountySkip', []));   // id -> {at, sig}: ticked as collected
	let poolRows = [];
	let hitLog = load('log', []);

	const keyIn = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Minimal-access key (Public works without the attack bar)', value: load('key', '') });
	const typeIn = el('select', {}, el('option', { value: 'player', textContent: 'Contract target' }), el('option', { value: 'faction', textContent: 'Paid hits on a faction' }));
	const idsIn = el('input', { placeholder: 'Ids, e.g. 12345, 67890' });
	const ruleIn = ruleSelect();
	ruleIn.value = 'within:5';
	const noEdIn = el('input', { type: 'checkbox' });
	const noteIn = el('input', { placeholder: 'Optional: contract link, who pays' });
	const addBtn = el('button', { textContent: 'Add' });
	const radarBtn = el('button', { textContent: 'Start radar' });
	const soundIn = el('input', { type: 'checkbox', checked: load('sound', true) });
	const volumeIn = el('input', { type: 'range', min: 0, max: 100, value: load('volume', 25), title: 'Alert volume' });
	const bountyOn = el('input', { type: 'checkbox', checked: load('bountyOn', false) });
	const bountyMaxLevel = el('input', { type: 'number', min: 1, max: 100, placeholder: 'any', value: load('bountyMaxLevel', '') });
	const bountyMinReward = el('input', { type: 'number', min: 0, placeholder: '0', value: load('bountyMinReward', '') });
	const poolOn = el('input', { type: 'checkbox', checked: load('poolOn', false) });
	const ffKeyIn = el('input', { type: 'password', autocomplete: 'off', placeholder: '16-character FFScouter key', value: load('ffKey', '') });
	const maxFfIn = el('input', { type: 'number', min: 1, max: 10, step: 0.1, placeholder: 'off', value: load('maxFf', '3') });
	const chainOn = el('input', { type: 'checkbox', checked: load('chainOn', false) });
	const poolMaxFf = el('input', { type: 'number', min: 1, max: 10, step: 0.1, value: load('poolMaxFf', '3') });
	const poolMaxLevel = el('input', { type: 'number', min: 1, max: 100, value: load('poolMaxLevel', '100') });
	const statusEl = el('div', { id: 'tm-status' });
	const lastEl = el('div', { id: 'tm-last' });
	const listEl = el('div', {});
	const manageEl = el('div', {});
	const logEl = el('div', { className: 'tm-log' });
	const clearLogBtn = el('button', { textContent: 'Clear log' });

	const panel = el('div', { id: 'tm-panel', hidden: true },
		el('strong', { textContent: 'Merc Radar' }), statusEl, radarBtn, lastEl, listEl,
		el('details', {}, el('summary', { textContent: 'Contracts' }),
			el('div', { className: 'tm-two' }, field('Type', typeIn), field('Ids', idsIn)),
			field('Contract terms', ruleIn),
			el('label', {}, noEdIn, ' No early discharge (needs the target\'s faction list)'),
			field('Note', noteIn), addBtn, manageEl),
		el('details', {}, el('summary', { textContent: 'Bounty board' }),
			el('label', {}, bountyOn, ' Hunt Torn\'s bounty board'),
			el('div', { className: 'tm-two' }, field('Max target level', bountyMaxLevel), field('Min total reward ($)', bountyMinReward)),
			el('div', { className: 'tm-note', textContent: `Reads the whole board (up to ${Merc.BOUNTY_MAX_PAGES * Merc.BOUNTY_PAGE} bounties), stacks every bounty on a target and drops anyone above your FF limit, expired bounties, your own faction and bounties you listed. One hospitalisation pays ONE bounty, the highest on the target, so rows show $ per hit, with the rest of the pile as "+$" for later hits. Order: out now (most $ per hit first), then whoever is out soonest. The top ${Merc.MAX_BOUNTY_WATCH} are watched live and you get a heads-up ${Merc.SOON_WARN_SEC} s before a release. Tick ✓ once you collect: the target hides until the board changes for them, or ${Merc.BOUNTY_BLACKLIST_H} h.` })),
		el('details', {}, el('summary', { textContent: 'Fair Fight (FFScouter)' }),
			field('FFScouter key', ffKeyIn),
			field('Max FF for me (blank = off)', maxFfIn),
			el('div', { className: 'tm-note' }, 'With a key, every target shows its Fair Fight against YOU and anyone above your limit is marked DANGER instead of hit. FF 1 = far weaker than you, 2 = easy, 3 = closer, 3.67 = equal stats, above that they out-stat you. Register your Torn key at ', el('a', { href: 'https://ffscouter.com/', target: '_blank', rel: 'noopener', textContent: 'ffscouter.com' }), ' and read its data policy there. Only your FFScouter key and target ids go to it, at most one call per 10 minutes.')),
		el('details', {}, el('summary', { textContent: 'Chain kit' }),
			el('label', {}, chainOn, ' Alert when my chain timer drops under 90 s (needs a Minimal key)'),
			el('label', {}, poolOn, ' Target pool: inactive players under a FF limit (needs the FFScouter key)'),
			el('div', { className: 'tm-two' }, field('Pool max FF', poolMaxFf), field('Pool max level', poolMaxLevel)),
			el('div', { className: 'tm-note', textContent: 'The pool is refreshed every 5 minutes, out-of-hospital first, lowest level first. For when you are hired to chain or chain-save: every row is a one-click attack page, nothing more.' })),
		el('details', {}, el('summary', { textContent: 'Hit log' }), clearLogBtn, logEl),
		el('details', {}, el('summary', { textContent: 'Settings' }),
			field('Torn API key', keyIn),
			el('div', { className: 'tm-note', textContent: 'Minimal access shows your energy and life on the attack page and your chain timer; Public does everything else. Stored only in this browser\'s script storage and sent only to api.torn.com. Nothing is shared with anyone. Used only to read player, faction, bounty and bar data for your own alerts.' }),
			el('label', {}, soundIn, ' Sound on alerts'), field('Alert volume', volumeIn)));
	const toggle = el('button', { id: 'tm-btn', textContent: 'Merc', onclick: () => { panel.hidden = !panel.hidden; } });
	document.body.append(toggle, panel);

	const say = (text) => { statusEl.textContent = text; };

	/* ---------- alerts ---------- */

	function beep() {
		if (!soundIn.checked) return;
		const vol = Math.max(0, Math.min(1, (Number(volumeIn.value) || 0) / 100));
		if (!vol) return;
		try {
			const ctx = new AudioContext();
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			gain.gain.setValueAtTime(0.15 * vol, ctx.currentTime);   // 0.15 is a soft ping; 1.0 was the raw oscillator at full blast
			gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
			osc.connect(gain);
			gain.connect(ctx.destination);
			osc.frequency.value = 880;
			osc.start();
			osc.stop(ctx.currentTime + 0.3);
			osc.onended = () => ctx.close();
		} catch (e) { /* the browser needs a click on the page before it allows sound */ }
	}
	function alertMe(title, text, url) {
		beep();
		// Clicking the popup is the user's click: it goes to the page they asked for. It never attacks or revives.
		const go = () => { window.focus(); if (url) location.assign(url); };
		// The browser's own Notification delivers its click; Tampermonkey's GM_notification often drops onclick on Windows toasts.
		let shown = false;
		if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
			try { const n = new Notification(title, { body: text, tag: 'tornmerc', renotify: true }); n.onclick = () => { n.close(); go(); }; shown = true; } catch (e) { /* fall through to GM_notification */ }
		}
		if (!shown && typeof GM_notification === 'function') GM_notification({ title, text, timeout: 15000, onclick: go });
		document.title = `(!) ${title}`;
		lastEl.textContent = '';
		if (url) lastEl.append(el('span', { textContent: `Last alert: ${title} ` }), el('a', { className: 'tm-hit', href: url, textContent: 'Attack' }));   // the in-page fallback when the toast click goes nowhere
	}

	/* ---------- radar ---------- */

	const tabId = Math.random().toString(36).slice(2);
	const budget = Merc.makeBudget(Merc.BUDGET_PER_MIN);
	const live = new Map();       // player id -> latest player object
	const members = new Map();    // faction id -> member ids
	const dueAt = {};
	const period = {};            // source key -> ms between polls, so nextDue can tell "late" from "slow"
	const outSince = new Map();   // player id -> second first seen out of hospital
	let prevHits = new Set();
	let soonWarned = new Set();
	let myStatus = null;
	let myId = 0;
	let myFaction = 0;
	let myBars = null;
	let barsOk = true;            // false once /user/bars says the key is Public
	let poolAt = 0;
	const stats = new Map();      // player id -> {ff, bs} from FFScouter
	const statsAt = new Map();    // player id -> ms of the last lookup
	let chainArmed = true;
	let running = false;
	let problem = '';

	function readLock() { try { return JSON.parse(localStorage.getItem('tornmerc.lock')); } catch (e) { return null; } }
	function holdLock(now) {
		if (!Merc.ownsLock(readLock(), tabId, now)) return false;
		try { localStorage.setItem('tornmerc.lock', JSON.stringify({ tab: tabId, at: now })); } catch (e) { /* no storage: every tab polls alone */ }
		return true;
	}

	function allWatches() { return bountyOn.checked ? watches.concat(bountyWatches) : watches; }
	function rebuildBounties() {
		const nowSec = Math.floor(Date.now() / 1000);
		bountySkip = Merc.pruneSkip(bountySkip, nowSec);
		const maxFf = ffKeyIn.value.trim() ? Number(maxFfIn.value) || 0 : 0;
		bountyWatches = Merc.bountyWatches(bountyRaw.flat(), { myId, maxLevel: Number(bountyMaxLevel.value) || 0, minReward: Number(bountyMinReward.value) || 0, maxFf, stats, skip: bountySkip, now: nowSec });
	}

	function buildRows(nowSec) {
		const country = myStatus ? Merc.countryOf(myStatus) : null;
		const rows = [];
		const maxFf = ffKeyIn.value.trim() ? Number(maxFfIn.value) || 0 : 0;
		const row = (key, id, p, watch, label) => {
			const st = stats.get(id) || { ff: 0, bs: '' };
			const r = Merc.ffGate(Merc.evaluate(p, watch, country, nowSec, myFaction), st.ff, maxFf);
			rows.push({ key, id, name: p.name || String(id), level: Number(p.level) || 0, label, watch: watch, player: p, ff: st.ff, bs: st.bs, bounty: watch.bounty, hunter: Merc.hospitalizedBy(p.status), outFor: outSince.has(id) ? nowSec - outSince.get(id) : 0, ...r });
		};
		for (const w of allWatches()) {
			const p = live.get(w.id);
			if (p) row(`p${w.id}`, w.id, p, w, w.bounty ? `${Merc.money(w.bounty.perHit)} per hit by ${w.bounty.lister}${w.bounty.count > 1 ? ` · ${w.bounty.count} bounties, ${Merc.money(w.bounty.total)} in all` : w.bounty.hits > 1 ? ` · x${w.bounty.hits}` : ''}` : w.note || 'contract');
		}
		for (const f of factions) {
			for (const id of members.get(f.id) || []) {
				if (id !== myId) row(`f${f.id}:${id}`, id, live.get(id), f, `paid hits: faction ${f.id}`);
			}
		}
		return Merc.sortRows(rows);
	}

	function render(rows, nowSec) {
		listEl.textContent = '';
		const body = el('tbody', {});
		const bountyRows = Merc.rankBounties(rows.filter((x) => x.bounty), nowSec);
		const rest = rows.filter((x) => !x.bounty && (x.state !== 'no' || x.key[0] === 'p' || /^DANGER/.test(x.why)));
		const shown = bountyRows.concat(rest, poolOn.checked ? poolRows : []);
		let group = '';
		for (const r of shown.slice(0, Merc.MAX_ROWS)) {
			const g = r.bounty ? `Bounties (${bountyRows.length} of ${bountyRaw.flat().length} on the board, under FF ${Number(maxFfIn.value) || 'off'}) · $ per hit` : r.key.startsWith('pool') ? 'Chain pool' : 'Contracts';
			if (g !== group) { group = g; body.append(el('tr', {}, el('td', { colSpan: 4, className: 'tm-group', textContent: g }))); }
			const left = r.until - nowSec;
			const what = r.state === 'soon' && left > 0 ? `${r.why} ${Merc.clock(left)}` : r.why;
			const when = r.state === 'hit' ? `OUT NOW${r.outFor >= 60 ? ` ${Math.floor(r.outFor / 60)}m` : ''}` : r.state === 'soon' && left > 0 ? `out in ${Merc.clock(left)}` : r.why;
			const exp = r.bounty && r.bounty.expires > nowSec ? ` · exp ${Merc.clock(r.bounty.expires - nowSec)}` : '';
			body.append(el('tr', { className: `tm-state-${r.state}${/^DANGER/.test(r.why) ? ' tm-danger' : ''}` },
				el('td', {}, el('a', { href: Merc.profileUrl(r.id), textContent: r.name, title: `${r.label}${r.bs ? ` · est. ${r.bs}` : ''}${r.hunter ? ` · last hospitalized by ${r.hunter}: expect a race` : ''}${exp}` })),
				el('td', { textContent: r.ff ? `${r.level} · FF ${r.ff.toFixed(2)}` : String(r.level) }),
				el('td', { textContent: r.bounty ? `${Merc.money(r.bounty.perHit)}${r.bounty.more ? ` +${Merc.money(r.bounty.more)}` : ''} · ${when}${r.hunter ? ' · hunted' : ''}` : what }),
				el('td', {}, el('a', { className: 'tm-hit', href: Merc.attackUrl(r.id), textContent: 'Attack' }), r.bounty ? el('button', { className: 'tm-x', textContent: '✓', title: 'Collected: hide until the board changes for them (24 h at most)', onclick: () => { bountySkip.set(r.id, { at: Math.floor(Date.now() / 1000), sig: r.bounty.sig }); save('bountySkip', [...bountySkip]); rebuildBounties(); } }) : '')));
		}
		if (body.childElementCount) listEl.append(el('table', {}, body));
		else listEl.append(el('div', { className: 'tm-note', textContent: running ? 'Nobody to show yet.' : 'Add contracts, then start the radar.' }));
	}

	function renderManage() {
		manageEl.textContent = '';
		const line = (text, onRemove) => el('div', {}, el('span', { textContent: text }), el('button', { className: 'tm-x', textContent: '×', title: 'Remove', onclick: onRemove }));
		const ruleName = (rule) => (Merc.RULES.find(([v]) => v === rule) || [rule, rule])[1];
		for (const w of watches) manageEl.append(line(`Target ${w.id}: ${ruleName(w.rule)}${w.noED ? ', no ED' : ''}${w.note ? ` · ${w.note}` : ''}`, () => { watches = watches.filter((x) => x !== w); save('watches', watches); live.delete(w.id); renderManage(); }));
		for (const f of factions) manageEl.append(line(`Faction ${f.id}: ${ruleName(f.rule)}${f.noED ? ', no ED' : ''}`, () => { factions = factions.filter((x) => x !== f); save('factions', factions); members.delete(f.id); renderManage(); }));
	}

	function renderLog() {
		logEl.textContent = '';
		for (const e of hitLog.slice().reverse()) logEl.append(el('div', { textContent: e.text }));
		if (!hitLog.length) logEl.append(el('div', { className: 'tm-note', textContent: 'Each time a target clears its terms, a line lands here to paste as proof.' }));
	}

	function absorb(src, json) {
		if (src.key === 'me') {
			myId = Number(json.profile.id);
			if (!Merc.allowed(myId)) { stop(Merc.deniedText(myId)); throw new Error(Merc.deniedText(myId)); }   // the key owner is not on the list: nothing else is read
			myStatus = json.profile.status; myFaction = Number(json.profile.faction_id) || 0; return [json.profile];
		}
		if (src.key === 'bars') {
			myBars = json.bars;
			if (chainOn.checked) {
				const c = Merc.chainAlert(json.bars.chain, Merc.CHAIN_WARN_SEC, chainArmed);
				chainArmed = c.armed;
				if (c.alert) alertMe('Chain timer low', `${json.bars.chain.current} chain · ${Merc.clock(json.bars.chain.timeout)} left`, null);
			}
			return [];
		}
		if (src.key.startsWith('bounties')) {
			const page = Number(src.key.slice(8)) || 0;
			bountyRaw[page] = json.bounties || [];
			const meta = json._metadata || {};
			if (meta.total !== undefined && meta.total !== null) bountyTotal = Number(meta.total) || 0;
			else if (meta.links && meta.links.next) bountyTotal = Math.max(bountyTotal, (page + 2) * Merc.BOUNTY_PAGE);   // no total: there is at least one more page
			else bountyTotal = Math.min(bountyTotal || Infinity, (page + 1) * Merc.BOUNTY_PAGE);
			bountyRaw.length = Math.min(bountyRaw.length, Merc.boardPages(bountyTotal));
			rebuildBounties();
			return [];
		}
		if (src.key[0] === 'f') {
			const fid = Number(src.key.slice(1));
			const list = json.members || [];
			members.set(fid, list.map((m) => m.id));
			for (const w of watches) { if (w.factionId === fid && !list.some((m) => m.id === w.id)) { w.factionId = 0; live.delete(w.id); save('watches', watches); } }   // left the faction: back to reading their profile
			for (const m of list) live.set(m.id, m);
			return list;
		}
		const p = json.profile;
		live.set(p.id, p);
		Merc.trackOut(outSince, p.id, p.status, Math.floor(Date.now() / 1000));
		const w = watches.find((x) => x.id === p.id);
		if (w && w.noED && p.faction_id && w.factionId !== p.faction_id) { w.factionId = p.faction_id; save('watches', watches); }
		return [p];
	}

	async function refreshPool(now) {
		if (!poolOn.checked || !ffKeyIn.value.trim() || now - poolAt < Merc.POOL_REFRESH_SEC * 1000) return;
		poolAt = now;
		try {
			const json = await getJson(Merc.poolUrl(ffKeyIn.value.trim(), { maxFf: Number(poolMaxFf.value) || 3, maxLevel: Number(poolMaxLevel.value) || 100 }));
			if (json && json.error) problem = `FFScouter: ${json.error.message || json.error}`;
			else poolRows = Merc.poolRows(json, Math.floor(now / 1000));
		} catch (e) { problem = `FFScouter: ${e.message}`; }
	}

	async function refreshStats(now, ids) {
		const key = ffKeyIn.value.trim();
		if (!key) return;
		const stale = Merc.staleStatIds(ids, statsAt, now);
		if (!stale.length) return;
		for (const id of stale) statsAt.set(id, now);   // one attempt per refresh window even if it fails
		try {
			const json = await getJson(Merc.statsUrl(key, stale));
			if (json && json.error) { problem = `FFScouter: ${json.error.message || json.error}`; return; }
			for (const [id, st] of Merc.parseStats(json)) stats.set(id, st);
		} catch (e) { problem = `FFScouter: ${e.message}`; }
	}

	async function tick() {
		if (!running) return;
		const now = Date.now();
		try {
			if (!holdLock(now)) { say('Radar is running in another Torn tab.'); return; }
			const sources = [{ key: 'me', path: '/user/profile' }];   // profile, not basic: it carries my faction id, so faction mates are never listed
			if (barsOk) sources.push({ key: 'bars', path: '/user/bars' });
			if (bountyOn.checked) for (let i = 0; i < Merc.boardPages(bountyTotal); i++) sources.push({ key: `bounties${i}`, path: `/torn/bounties?limit=${Merc.BOUNTY_PAGE}&offset=${i * Merc.BOUNTY_PAGE}` });
			sources.push(...Merc.sources(allWatches(), factions));
			const src = Merc.nextDue(sources, dueAt, now, budget.remaining(now), period);
			if (src) {
				budget.hit(now);
				dueAt[src.key] = now + 60000;
				const json = await getJson(Merc.url(src.path, keyIn.value.trim(), Math.floor(now / 1000)));
				const err = Merc.apiError(json);
				if (err && src.key === 'bars' && err.code === 16) { barsOk = false; problem = 'Attack bar needs a Minimal key'; }
				else if (err && err.fatal) { stop(err.text); return; }
				else if (err) problem = `${src.key}: ${err.text}`;
				else {
					const seen = absorb(src, json);
					const fixed = src.key === 'me' ? 60 : src.key === 'bars' ? (chainOn.checked ? 15 : 30) : src.key.startsWith('bounties') ? 60 : Merc.pollSeconds(seen, Math.floor(now / 1000));
					period[src.key] = fixed * 1000;
					dueAt[src.key] = now + fixed * 1000;
				}
			}
			await refreshPool(now);
			await refreshStats(now, [...allWatches().map((w) => w.id), ...bountyRaw.flat().map((b) => Number(b.target_id)), ...[...members.values()].flat()]);
			if (bountyOn.checked) rebuildBounties();   // FF may have just arrived; re-filter the board
			const nowSec = Math.floor(Date.now() / 1000);
			const rows = buildRows(nowSec);
			for (const r of Merc.newlyHit(rows, prevHits)) {
				alertMe(r.bounty ? `${Merc.money(r.bounty.perHit)} bounty: ${r.name} is OUT` : `${r.name} can be hit`, `Level ${r.level}${r.ff ? ` · FF ${r.ff.toFixed(2)}` : ''} · ${r.label}${r.bounty ? ' · hospitalize to claim' : ''} · click to open the attack page`, Merc.attackUrl(r.id));
				hitLog = hitLog.concat(Merc.logEntry(r, r.player, r.watch, nowSec)).slice(-Merc.LOG_MAX);
				save('log', hitLog);
				renderLog();
			}
			prevHits = new Set(rows.filter((r) => r.state === 'hit').map((r) => r.key));
			const soon = Merc.newlySoon(rows, soonWarned, nowSec, Merc.SOON_WARN_SEC);   // the race is won by whoever is already on the attack page
			soonWarned = soon.warned;
			for (const r of soon.alerts) alertMe(`${Merc.money(r.bounty.perHit)} bounty: ${r.name} out in ${Merc.clock(r.until - nowSec)}`, `Level ${r.level}${r.ff ? ` · FF ${r.ff.toFixed(2)}` : ''}${r.hunter ? ` · last taken by ${r.hunter}` : ''} · click to sit on the attack page`, Merc.attackUrl(r.id));
			render(rows, nowSec);
			updateBar(rows, nowSec);
			const n = watches.length + factions.length;
			const nb = bountyOn.checked ? ` · ${bountyWatches.length} bounties (${bountyRaw.flat().length} of ${bountyTotal || '?'} on board)` : '';
			const hits = Merc.hitsAffordable(myBars);
			say(`Watching ${n} contract${n === 1 ? '' : 's'}${nb}${ffKeyIn.value.trim() ? ` · FF max ${Number(maxFfIn.value) || 'off'}` : ''}${poolOn.checked ? ` · pool ${poolRows.length}` : ''}${hits === null ? '' : ` · energy for ${hits} hit${hits === 1 ? '' : 's'}`} · ${Merc.BUDGET_PER_MIN - budget.remaining(Date.now())}/${Merc.BUDGET_PER_MIN} calls a minute${problem ? ` · ${problem}` : ''}`);
		} catch (e) {
			say(`Radar error: ${e.message}. Retrying.`);
		} finally {
			if (running) setTimeout(tick, Merc.TICK_MS);
		}
	}

	/* ---------- attack-page bar ---------- */

	const attackTarget = Merc.attackPageTarget(location.pathname, location.search);
	let bar = null;
	function updateBar(rows, nowSec) {
		if (!attackTarget) return;
		if (!bar) { bar = el('div', { id: 'tm-bar' }); document.body.prepend(bar); }
		const row = rows.find((r) => r.id === attackTarget) || null;
		bar.textContent = Merc.barText(myBars, row, nowSec);
		bar.className = row ? (row.state === 'hit' ? 'tm-ok' : 'tm-bad') : '';
	}

	function stop(reason) {
		running = false;
		radarBtn.textContent = 'Start radar';
		toggle.classList.remove('tm-live');
		save('running', false);
		say(reason || 'Radar stopped.');
	}
	function start() {
		if (!keyIn.value.trim()) { say('Paste your API key under Settings first.'); return; }
		save('key', keyIn.value.trim());
		// Asked on the Start click (a user gesture), so the browser's own notifications, whose click opens the attack page, are allowed.
		if (typeof Notification !== 'undefined' && Notification.permission === 'default') { try { Notification.requestPermission().catch(() => {}); } catch (e) { /* old browsers take a callback; GM_notification covers them */ } }
		running = true;
		problem = '';
		barsOk = true;
		radarBtn.textContent = 'Stop radar';
		toggle.classList.add('tm-live');
		save('running', true);
		tick();
	}

	radarBtn.addEventListener('click', () => { if (running) stop(); else start(); });
	soundIn.addEventListener('change', () => save('sound', soundIn.checked));
	volumeIn.addEventListener('change', () => { save('volume', Number(volumeIn.value)); beep(); });
	keyIn.addEventListener('change', () => save('key', keyIn.value.trim()));
	ffKeyIn.addEventListener('change', () => save('ffKey', ffKeyIn.value.trim()));
	for (const [input, key] of [[bountyOn, 'bountyOn'], [poolOn, 'poolOn'], [chainOn, 'chainOn']]) input.addEventListener('change', () => { save(key, input.checked); poolAt = 0; });
	maxFfIn.addEventListener('change', () => save('maxFf', maxFfIn.value));
	for (const [input, key] of [[bountyMaxLevel, 'bountyMaxLevel'], [bountyMinReward, 'bountyMinReward'], [poolMaxFf, 'poolMaxFf'], [poolMaxLevel, 'poolMaxLevel']]) input.addEventListener('change', () => { save(key, input.value); poolAt = 0; for (let i = 0; i < Merc.BOUNTY_MAX_PAGES; i++) dueAt[`bounties${i}`] = 0; });
	clearLogBtn.addEventListener('click', () => { hitLog = []; save('log', hitLog); renderLog(); });
	addBtn.addEventListener('click', () => {
		const ids = Merc.parseIds(idsIn.value);
		if (!ids.length) { say('Enter at least one id.'); return; }
		const entry = (id) => ({ id, rule: ruleIn.value, noED: noEdIn.checked, note: noteIn.value.trim() });
		if (typeIn.value === 'faction') {
			factions = factions.filter((f) => !ids.includes(f.id)).concat(ids.map(entry));
			save('factions', factions);
		} else {
			watches = watches.filter((w) => !ids.includes(w.id)).concat(ids.map(entry));
			save('watches', watches);
		}
		idsIn.value = '';
		noteIn.value = '';
		renderManage();
	});

	renderManage();
	renderLog();
	render([], 0);
	if (load('running', false) && keyIn.value.trim()) start();
})();
