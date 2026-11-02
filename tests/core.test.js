'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Merc = require('../tornmerc.user.js');

const NOW = 1000000;
const abroad = (where) => ({ state: 'Abroad', description: `In ${where}`, until: null });
const okay = { state: 'Okay', description: 'Okay', until: null };
const hospital = (until) => ({ state: 'Hospital', description: 'In hospital', until });
const seen = (status, agoSec) => ({ status, timestamp: NOW - agoSec });

test('parseIds keeps valid unique ids in order', () => {
	assert.deepEqual(Merc.parseIds('12, 34\n56;12 x -1 0 1.5'), [12, 34, 56]);
	assert.deepEqual(Merc.parseIds(''), []);
});

test('countryOf reads where a player can be hit', () => {
	assert.equal(Merc.countryOf(okay), 'Torn');
	assert.equal(Merc.countryOf(abroad('South Africa')), 'South Africa');
	assert.equal(Merc.countryOf(hospital(1)), null);
	assert.equal(Merc.countryOf({ state: 'Traveling', description: 'Traveling to Japan' }), null);
	assert.equal(Merc.countryOf(null), null);
});

test('activityOk follows each contract rule', () => {
	assert.equal(Merc.activityOk('any', null, NOW), true);
	assert.equal(Merc.activityOk('online', seen('Online', 0), NOW), true);
	assert.equal(Merc.activityOk('online', seen('Idle', 10), NOW), false);
	assert.equal(Merc.activityOk('active', seen('Idle', 900), NOW), true);
	assert.equal(Merc.activityOk('active', seen('Offline', 900), NOW), false);
	assert.equal(Merc.activityOk('within:5', seen('Offline', 299), NOW), true);
	assert.equal(Merc.activityOk('within:5', seen('Offline', 301), NOW), false);
	assert.equal(Merc.activityOk('within:5', seen('Online', 9999), NOW), true);
	assert.equal(Merc.activityOk('idle:30', seen('Offline', 1800), NOW), true);
	assert.equal(Merc.activityOk('idle:30', seen('Offline', 1799), NOW), false);
	assert.equal(Merc.activityOk('idle:30', seen('Online', 9999), NOW), false);
});

test('evaluate clears a target only when every condition holds', () => {
	const watch = { rule: 'within:5', noED: true };
	const ok = { status: okay, last_action: seen('Online', 0), has_early_discharge: false };
	assert.equal(Merc.evaluate(ok, watch, 'Torn', NOW).state, 'hit');
	assert.deepEqual(Merc.evaluate({ ...ok, has_early_discharge: true }, watch, 'Torn', NOW).why, 'has early discharge');
	assert.equal(Merc.evaluate({ ...ok, last_action: seen('Offline', 999) }, watch, 'Torn', NOW).why, 'activity rule');
	assert.equal(Merc.evaluate({ ...ok, status: abroad('Japan') }, watch, 'Torn', NOW).why, 'in Japan');
	assert.equal(Merc.evaluate({ ...ok, status: abroad('Japan') }, watch, 'japan', NOW).state, 'hit');
	assert.deepEqual(Merc.evaluate({ ...ok, status: hospital(NOW + 30) }, watch, 'Torn', NOW), { state: 'soon', why: 'hospital', until: NOW + 30 });
	assert.equal(Merc.evaluate({ ...ok, status: { state: 'Traveling', until: null } }, watch, 'Torn', NOW).why, 'flying');
	assert.equal(Merc.evaluate({ ...ok, status: { state: 'Federal', until: null } }, watch, 'Torn', NOW).why, 'federal');
});

test('evaluate waits for faction data before clearing a no-ED target', () => {
	const fromProfile = { status: okay, last_action: seen('Online', 0) };
	assert.equal(Merc.evaluate(fromProfile, { rule: 'any', noED: true, factionId: 9 }, 'Torn', NOW).why, 'checking early discharge');
	assert.equal(Merc.evaluate({ ...fromProfile, has_early_discharge: false }, { rule: 'any', noED: true, factionId: 9 }, 'Torn', NOW).state, 'hit');
	assert.equal(Merc.evaluate(fromProfile, { rule: 'any', noED: true, factionId: 0 }, 'Torn', NOW).state, 'hit');
});

test('evaluate lets an unknown location through when mine is unknown', () => {
	assert.equal(Merc.evaluate({ status: okay }, { rule: 'any' }, null, NOW).state, 'hit');
});

test('bountyWatches stacks every bounty on a target and filters by me, level, reward, FF and blacklist', () => {
	const b = (target_id, target_level, reward, quantity, lister_id, valid_until) => ({ target_id, target_name: `t${target_id}`, target_level, reward, quantity, lister_id, lister_name: lister_id ? `l${lister_id}` : null, valid_until: valid_until || 0 });
	const stats = new Map([[4, { ff: 5 }], [2, { ff: 1.5 }]]);
	const list = Merc.bountyWatches([
		b(1, 50, 1e6, 1, 7), b(2, 10, 100000, 2, 7, 500), b(2, 10, 50000, 1, 8, 900), b(3, 5, 1000, 1, 7), b(4, 8, 500000, 1, 7), b(5, 9, 400000, 1, 7), b(99, 1, 1e9, 1, 7), b(6, 3, 1e6, 1, 99),
	], { myId: 99, maxLevel: 40, minReward: 20000, maxFf: 3, stats, skip: new Set([5]), max: 10 });
	assert.deepEqual(list.map((w) => w.id), [2]);
	assert.equal(list[0].bounty.total, 250000);
	assert.equal(list[0].bounty.count, 2);
	assert.equal(list[0].bounty.quantity, 3);
	assert.equal(list[0].bounty.expires, 900);
	assert.equal(list[0].rule, 'any');
	const byMoney = Merc.bountyWatches([b(1, 5, 1, 1, 2), b(2, 3, 9, 1, 2)], { max: 1 });
	assert.equal(byMoney[0].id, 2);
	assert.equal(Merc.bountyWatches([b(7, 5, 1, 1, 2)], { maxFf: 3, stats: new Map() }).length, 1, 'unknown FF is kept until stats arrive');
});

test('bountyKey: out now first, then by the minute of release', () => {
	const row = (state, total, until) => ({ state, bounty: { total }, until });
	assert.deepEqual(Merc.bountyKey(row('hit', 100000), NOW), { bucket: 0, cash: 100000 });
	assert.deepEqual(Merc.bountyKey(row('soon', 100000, NOW + 30), NOW), { bucket: 1, cash: 100000 });
	assert.deepEqual(Merc.bountyKey(row('soon', 100000, NOW + 600), NOW), { bucket: 11, cash: 100000 });
	assert.equal(Merc.bountyKey(row('no', 100000), NOW), null);
	assert.equal(Merc.bountyKey({ state: 'hit' }, NOW), null);
});

test('rankBounties: soonest out wins, cash breaks the tie, out-now on top', () => {
	const rows = Merc.rankBounties([
		{ key: 'mark', state: 'soon', bounty: { total: 2e6 }, until: NOW + 600, level: 43 },
		{ key: 'small', state: 'soon', bounty: { total: 50000 }, until: NOW + 120, level: 9 },
		{ key: 'now', state: 'hit', bounty: { total: 10000 }, level: 5 },
		{ key: 'now2', state: 'hit', bounty: { total: 300000 }, level: 30 },
		{ key: 'same', state: 'soon', bounty: { total: 90000 }, until: NOW + 125, level: 20 },
		{ key: 'dead', state: 'no', bounty: { total: 9e9 } },
	], NOW);
	assert.deepEqual(rows.map((r) => r.key), ['now2', 'now', 'same', 'small', 'mark']);
});

test('pruneSkip forgets collected bounties after the window', () => {
	const m = Merc.pruneSkip(new Map([[1, NOW - 10], [2, NOW - Merc.BOUNTY_BLACKLIST_H * 3600 - 1]]), NOW);
	assert.deepEqual([...m.keys()], [1]);
});

test('money is short', () => {
	assert.equal(Merc.money(950), '$950');
	assert.equal(Merc.money(250000), '$250k');
	assert.equal(Merc.money(1500000), '$1.5m');
	assert.equal(Merc.money(25000000), '$25m');
	assert.equal(Merc.money(2.5e9), '$2.50b');
});

test('sources dedupes and reads a no-ED target through its faction', () => {
	const list = Merc.sources([{ id: 1 }, { id: 2, noED: true, factionId: 9 }, { id: 3, noED: true }], [{ id: 9 }]);
	assert.deepEqual(list.map((s) => s.key), ['f9', 'u1', 'u3']);
	assert.equal(list[0].path, '/faction/9/members');
	assert.equal(list[1].path, '/user/1/profile');
});

test('pollSeconds speeds up near a hospital release', () => {
	assert.equal(Merc.pollSeconds([{ status: hospital(NOW + 30) }], NOW), 2);
	assert.equal(Merc.pollSeconds([{ status: hospital(NOW + 200) }], NOW), 15);
	assert.equal(Merc.pollSeconds([{ status: hospital(NOW + 9000) }], NOW), 60);
	assert.equal(Merc.pollSeconds([{ status: okay }], NOW), 30);
	assert.equal(Merc.pollSeconds([], NOW), 60);
});

test('nextDue takes the most overdue source and respects the budget', () => {
	const s = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
	assert.equal(Merc.nextDue(s, { a: 50, b: 10, c: 500 }, 100, 5).key, 'b');
	assert.equal(Merc.nextDue(s, { a: 500, b: 500, c: 500 }, 100, 5), null);
	assert.equal(Merc.nextDue(s, {}, 100, 0), null);
});

test('budget slides over one minute', () => {
	const b = Merc.makeBudget(2);
	b.hit(0); b.hit(1000);
	assert.equal(b.remaining(2000), 0);
	assert.equal(b.remaining(60500), 1);
});

test('newlyHit alerts once per clearance', () => {
	const rows = [{ key: 'a', state: 'hit' }, { key: 'b', state: 'hit' }, { key: 'c', state: 'soon' }];
	assert.deepEqual(Merc.newlyHit(rows, new Set(['a'])).map((r) => r.key), ['b']);
});

test('ownsLock lets one tab poll and takes over a dead one', () => {
	assert.equal(Merc.ownsLock(null, 'a', 0), true);
	assert.equal(Merc.ownsLock({ tab: 'a', at: 0 }, 'a', 1), true);
	assert.equal(Merc.ownsLock({ tab: 'b', at: 0 }, 'a', 1000), false);
	assert.equal(Merc.ownsLock({ tab: 'b', at: 0 }, 'a', Merc.LOCK_TTL_MS + 1), true);
});

test('apiError separates fatal errors from one bad source', () => {
	assert.equal(Merc.apiError({ members: [] }), null);
	assert.equal(Merc.apiError({ error: { code: 5, error: 'Too many requests' } }).fatal, true);
	assert.equal(Merc.apiError({ error: { code: 6, error: 'Incorrect ID' } }).fatal, false);
});

test('url encodes the key, tags the key log and can skip the cache', () => {
	assert.equal(Merc.url('/user/basic', 'a b'), 'https://api.torn.com/v2/user/basic?key=a%20b&comment=TornMerc');
	assert.equal(Merc.url('/torn/bounties?limit=100&offset=100', 'k'), 'https://api.torn.com/v2/torn/bounties?limit=100&offset=100&key=k&comment=TornMerc');
	assert.ok(Merc.url('/user/basic', 'k', 123).endsWith('&timestamp=123'));
});

test('poolUrl asks FFScouter for inactive targets inside the filters', () => {
	const u = new URL(Merc.poolUrl('abc', { maxFf: 2.5, maxLevel: 40 }));
	assert.equal(u.origin + u.pathname, 'https://ffscouter.com/api/v1/get-targets');
	assert.equal(u.searchParams.get('key'), 'abc');
	assert.equal(u.searchParams.get('maxff'), '2.5');
	assert.equal(u.searchParams.get('maxlevel'), '40');
	assert.equal(u.searchParams.get('inactiveonly'), '1');
	assert.equal(u.searchParams.get('limit'), '50');
});

test('poolRows keeps out-of-hospital targets first, lowest level', () => {
	const rows = Merc.poolRows({ targets: [
		{ player_id: 1, name: 'a', level: 20, fair_fight: 2.1, hospital_until: NOW + 100 },
		{ player_id: 2, name: 'b', level: 15, fair_fight: 2.5, hospital_until: 0 },
		{ player_id: 3, name: 'c', level: 9, fair_fight: 1.4, hospital_until: NOW - 5 },
		{ player_id: 0 },
	] }, NOW);
	assert.deepEqual(rows.map((r) => [r.id, r.state]), [[3, 'hit'], [2, 'hit'], [1, 'soon']]);
	assert.equal(rows[0].key, 'pool3');
	assert.deepEqual(Merc.poolRows(null, NOW), []);
});

test('ffGate turns a hit into DANGER above my Fair Fight limit', () => {
	const hit = { state: 'hit', why: 'hit now', until: 0 };
	assert.equal(Merc.ffGate(hit, 1.8, 3).state, 'hit');
	assert.deepEqual(Merc.ffGate(hit, 3.9, 3), { state: 'no', why: 'DANGER FF 3.90', until: 0 });
	assert.equal(Merc.ffGate(hit, 0, 3).why, 'FF unknown');
	assert.equal(Merc.ffGate(hit, 0, 0).state, 'hit');
	assert.equal(Merc.ffGate({ state: 'soon', why: 'hospital', until: 5 }, 9, 3).state, 'soon');
});

test('statsUrl batches at most 205 ids', () => {
	const ids = Array.from({ length: 300 }, (_, i) => i + 1);
	const u = new URL(Merc.statsUrl('k', ids));
	assert.equal(u.pathname, '/api/v1/get-stats');
	assert.equal(u.searchParams.get('targets').split(',').length, 205);
});

test('parseStats reads an array or a wrapped list', () => {
	const m = Merc.parseStats([{ player_id: 5, fair_fight: 2.25, bs_estimate_human: '1.2m' }, { player_id: 0 }]);
	assert.deepEqual(m.get(5), { ff: 2.25, bs: '1.2m' });
	assert.equal(Merc.parseStats({ targets: [{ player_id: 6, fair_fight: '3.1' }] }).get(6).ff, 3.1);
	assert.equal(Merc.parseStats(null).size, 0);
});

test('staleStatIds asks only for unknown or old ids', () => {
	const at = new Map([[1, 0], [2, 1000]]);
	assert.deepEqual(Merc.staleStatIds([1, 2, 3, 3], at, Merc.STATS_REFRESH_SEC * 1000 + 500), [1, 3]);
});

test('chainAlert fires once per drop and re-arms when the timer refills', () => {
	assert.deepEqual(Merc.chainAlert({ current: 20, timeout: 50 }, 90, true), { alert: true, armed: false });
	assert.deepEqual(Merc.chainAlert({ current: 20, timeout: 40 }, 90, false), { alert: false, armed: false });
	assert.deepEqual(Merc.chainAlert({ current: 21, timeout: 280 }, 90, false), { alert: false, armed: true });
	assert.deepEqual(Merc.chainAlert(null, 90, true), { alert: false, armed: true });
});

test('game links only ever carry a number', () => {
	assert.equal(Merc.attackUrl(123), 'https://www.torn.com/loader.php?sid=attack&user2ID=123');
	assert.ok(Merc.attackUrl('1&x=2').endsWith('user2ID=NaN'));
});

test('attackPageTarget reads the attack page and nothing else', () => {
	assert.equal(Merc.attackPageTarget('/loader.php', '?sid=attack&user2ID=555'), 555);
	assert.equal(Merc.attackPageTarget('/loader.php', '?sid=crimes'), 0);
	assert.equal(Merc.attackPageTarget('/profiles.php', '?XID=555'), 0);
	assert.equal(Merc.attackPageTarget('', ''), 0);
});

test('logEntry is one pasteable proof line', () => {
	const row = { id: 5, name: 'Bob', level: 12 };
	const player = { status: okay, last_action: seen('Idle', 180), has_early_discharge: false };
	const e = Merc.logEntry(row, player, { rule: 'within:5', note: 'merc server #12' }, NOW);
	assert.equal(e.id, 5);
	assert.equal(e.at, NOW);
	assert.match(e.text, /^Bob \[5\] lvl 12 cleared \d\d:\d\d:\d\d TCT: Okay, Idle 3m ago, no ED\. Terms: Active in last 5 min \(merc server #12\)$/);
	assert.match(Merc.logEntry(row, { status: okay }, { rule: 'any' }, NOW).text, /activity unknown, ED unknown\. Terms: Any activity$/);
});

test('barText tells the merc whether this target still meets the terms', () => {
	const bars = { energy: { current: 150, maximum: 150 }, life: { current: 40, maximum: 100 } };
	assert.equal(Merc.barText(bars, null, NOW), 'E 150/150 · Life 40/100 LOW · Not on your radar');
	assert.equal(Merc.barText(null, { name: 'Bob', state: 'hit' }, NOW), 'Bob: terms met');
	assert.equal(Merc.barText(null, { name: 'Bob', state: 'hit', ff: 2.5 }, NOW), 'Bob: terms met · FF 2.50');
	assert.equal(Merc.barText(null, { name: 'Bob', state: 'soon', why: 'hospital', until: NOW + 65 }, NOW), 'Bob: DO NOT HIT (hospital 1:05)');
	assert.equal(Merc.barText(null, { name: 'Bob', state: 'no', why: 'has early discharge', until: 0 }, NOW), 'Bob: DO NOT HIT (has early discharge)');
});

test('sortRows puts hittable first, then nearest release, then level', () => {
	const rows = Merc.sortRows([
		{ key: 'a', state: 'no', level: 1 },
		{ key: 'b', state: 'soon', level: 5, until: 200 },
		{ key: 'c', state: 'soon', level: 9, until: 100 },
		{ key: 'd', state: 'hit', level: 30 },
		{ key: 'e', state: 'hit', level: 10 },
	]);
	assert.deepEqual(rows.map((r) => r.key), ['e', 'd', 'c', 'b', 'a']);
});

test('clock and tct are short', () => {
	assert.equal(Merc.clock(65), '1:05');
	assert.equal(Merc.clock(3700), '1h 1m');
	assert.equal(Merc.clock(-5), '0:00');
	assert.equal(Merc.tct(0), '00:00:00');
	assert.equal(Merc.tct(3661), '01:01:01');
});

test('the budget stays under Torn\'s limit', () => {
	assert.ok(Merc.BUDGET_PER_MIN <= 100);
});

test('the script never requests torn.com pages or automates input', () => {
	const src = fs.readFileSync(path.join(__dirname, '..', 'tornmerc.user.js'), 'utf8');
	assert.doesNotMatch(src, /\.click\(|dispatchEvent|\.submit\(|location\.(href|replace)|window\.open/);
	assert.equal((src.match(/location\.assign\(/g) || []).length, 1, 'only the notification click navigates, and only to the page the user clicked for');
	assert.doesNotMatch(src, /innerHTML/);
	assert.doesNotMatch(src, /faction\/chain/);   // my chain timer comes from my own bars, never a faction endpoint
	assert.deepEqual([...new Set(src.match(/@connect\s+\S+/g))], ['@connect      api.torn.com', '@connect      ffscouter.com']);
});
