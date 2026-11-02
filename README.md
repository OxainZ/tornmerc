# Torn Merc Radar

A free Tampermonkey userscript for mercs in Torn City. It watches your contracts, Torn's bounty
board and the factions you are paid to hit, and alerts you the moment a target can be hit. It is
alerts only: you click Attack, Start Fight and every hit yourself.

## Install

1. Install Tampermonkey (Firefox or Chrome).
2. Open the install link and click **Install**:
   https://raw.githubusercontent.com/OxainZ/tornmerc/main/tornmerc.user.js
   Updates arrive on their own from the same link.
3. Reload torn.com and click **Merc** at the bottom left.
4. Under **Settings**, paste a **Minimal** API key (Public works too, without the attack bar and chain timer).
5. Under **Contracts**, add targets, then press **Start radar**.

**TornPDA:** Settings > User scripts > add > Remote URL, paste the same link.

## What it does

- **Contracts:** alerts when a target is out of hospital, in your country, and meets the
  contract's terms: online, active in the last 2 to 60 minutes, inactive for a set time, or any.
  Add a note such as the contract link or who pays.
- **No early discharge:** tick it and the radar skips targets Torn reports as eligible for early
  discharge. It reads the target's faction list for that, so factionless players are not checked.
- **Bounty board:** reads the whole board (300 bounties), stacks every bounty on a target, drops
  anyone above your FF limit, and lists the rest in hit order: out now (most cash first), then
  whoever is out soonest, bigger bounty first within the same minute. The top 25 are watched live
  and the alert says "$250k bounty: X is OUT". Tick a row once you collect and it hides for 24 h.
- **Paid hits on a faction:** every member under one rule, for turtling or hitting offliners.
  Hittable members are listed lowest level first.
- **Traders:** the "Online or idle" rule alerts when a trader lands or leaves hospital and is around.
- **Hunting abroad:** a target in another country only counts when you are in that country too, so
  in Japan the list is everyone you can hit in Japan.
- **Attack-page bar:** on the attack screen, a bar shows your energy and life and whether *this*
  target still meets its terms, so you never make an illegal hit.
- **Hit log:** each time a target clears its terms, one line is kept to paste as proof: who, when
  (TCT), their status, activity and early-discharge state, and the terms.
- **Fair Fight (optional):** with an FFScouter key, every target shows its Fair Fight against *you*,
  and anyone above the "Max FF for me" limit is marked DANGER instead of hit. Lowest level is not
  the same as weakest; this is what keeps a stacked low level from cooking you. FF 2 is easy,
  3.67 is equal stats, above that they out-stat you. Register your Torn key at ffscouter.com first.
- **Chain kit:** an alert when your own chain timer drops under 90 s (read from your own bars), and
  an optional target pool of inactive players under a FF and level limit, out of hospital first,
  refreshed every 5 minutes, for when you are hired to chain or chain-save.

Alerts are a desktop notification, a sound and the tab title. The **Merc** button turns green while
the radar runs.

## API use

- `api.torn.com` always; `ffscouter.com` only when you give it an FFScouter key (at most one
  stats call per 10 minutes and one pool call per 5). Never torn.com pages.
- At most 75 Torn requests a minute, leaving room under Torn's limit of 100.
- One tab polls; a new tab takes over within 5 seconds of the old one closing.
- Polling is every 60 s by default, 30 s for players who are out, 15 s within 5 minutes of leaving
  hospital and 2 s in the last minute, limited by the budget. Many targets poll slower.
- It only polls while a torn.com tab is open and the radar is on.

## What it will not do

It never clicks, submits, changes pages or attacks for you, and it will not get an auto-attack mode.

Not included from paid radars: illegal-hit evidence images and device sync.

## API key terms

| | |
|---|---|
| Data storage | Settings and the hit log stay in this browser's script storage |
| Data sharing | None. Torn requests go only to api.torn.com. With an FFScouter key set, that key, target ids and the pool filters go to ffscouter.com |
| Purpose | Read player, faction, bounty and bar data for your own alerts |
| Key storage and sharing | Stored locally, never shared |
| Key access level | Minimal (Public without the attack bar and chain timer) |

## Licence

MIT. Fork it, change it, share it.

## Develop

`npm test` runs the pure logic tests with Node's built-in runner. There is no build step.

Fan-made, not affiliated with Torn or FFScouter.
