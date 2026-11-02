# CLAUDE.md

tornmerc is Oxain's standalone, free Torn City merc radar: one Tampermonkey userscript,
`tornmerc.user.js`. It is deliberately separate from torncat; do not merge them.

- **Alerts only, never automates the game.** No clicking, submitting, page changes or attacks for
  the player, and no auto-attack mode. `tests/core.test.js` guards this.
- **Merc alone, never the merc's own faction.** Contracts, Torn's bounty board, factions the merc is
  paid to hit, the attack-page contract check, the hit log, Fair Fight on every row and an opt-in
  pool via FFScouter, the merc's own chain timer from `/user/bars`. No own-faction members; a test
  rejects `faction/chain`.
- **One hospitalisation claims one bounty, the highest on the target.** Torn pays the rest of a
  stacked pile on later hits, after the target leaves hospital again, and a quantity-N bounty is N
  claims. Rank and alert on `bounty.perHit`, never on the stacked total; bounties expire
  (`valid_until`). The attack page is `page.php?sid=attack` (Torn retired `loader.php`).
- **Lowest level is not weakest.** The FF gate (`Merc.ffGate`) exists because a stacked low level
  will cook the merc; never rank or alert on level alone when FF is available.
- **API only.** Never request torn.com pages. `@connect` is `api.torn.com` plus `ffscouter.com`
  (used only when the pool is switched on; the user registers there themselves).
- **Polling stays under budget.** `Merc.BUDGET_PER_MIN` caps calls; one tab polls via the lock.
- **The API key is the only secret.** Script storage only, never in the repo or a log. Public access.
- **Remote data never touches `innerHTML`.** Use `textContent`.
- **One file, no build.** Pure logic lives on `Merc` and is exported for Node; DOM code stays below
  the `typeof document` guard. Add a test for each pure helper. `npm test`.
- **Private by Torn id.** `Merc.ALLOWED` is the allowlist; the radar stops at the first profile read
  when the key owner is not on it, and an empty list means nobody. `node tools/allow.js <id>` adds
  one, then release. Licence is all rights reserved since 0.8.0; never reintroduce MIT text.
- **Own code only.** Merogie's radar is a paid product: feature ideas are fine, copying its code is not.
- **Release = bump `@version` + `Merc.VERSION`, run `npm run meta`, commit, push.** Tampermonkey
  checks `tornmerc.meta.js` for updates; a stale meta file means nobody updates.
