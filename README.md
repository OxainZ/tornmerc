# Torn Merc Radar

A private Tampermonkey userscript for mercs in Torn City, by invitation: it runs only for Torn ids on its allowlist. It watches your contracts, Torn's bounty
board and the factions you are paid to hit, and alerts you the moment a target can be hit. It is
alerts only: you click Attack, Start Fight and every hit yourself.

## Install

0. Ask Oxain for access with your Torn id. Without it the radar stops at start and shows your id.
1. Install Tampermonkey (Firefox or Chrome).
2. Open the install link and click **Install**:
   https://raw.githubusercontent.com/OxainZ/tornmerc/main/tornmerc.user.js
   Updates arrive on their own from the same link.
3. Reload torn.com and click **Merc** at the bottom left.
4. Under **Settings**, paste a **Limited** API key (Minimal loses the proof log; Public also loses the attack bar and chain timer).
5. Under **Contracts**, add targets, then press **Start radar**.

**TornPDA:** Settings > User scripts > add > Remote URL, paste the same link.

## What it does

- **Contracts:** alerts when a target is out of hospital, in your country, and meets the
  contract's terms: online, active in the last 2 to 60 minutes, inactive for a set time, or any.
  Add a note such as the contract link or who pays.
- **No early discharge:** tick it and the radar skips targets Torn reports as eligible for early
  discharge. It reads the target's faction list for that, so factionless players are not checked.
- **Bounty board:** reads the whole board (every page, up to 5,000 bounties, on a rolling schedule of about 15 calls a minute), stacks every bounty on
  a target and drops anyone above your FF limit, expired bounties, your own faction mates and
  bounties you listed. One hospitalisation pays **one** bounty, the highest on the target, so every
  row shows $ per hit, with the rest of the pile as "+$" for follow-up hits once they leave hospital
  again. Hit order: out now (most $ per hit first, with how long they have been out), then whoever
  is out soonest, bigger bounty first within the same minute. A release is a race, so a coming
  release counts $ divided by one plus the different hunters the radar has seen take that target
  ("hunted x3"): an unhunted $500k outranks a $1m that three others camp. The top 120 are watched live; 30 s
  before a release you get "$250k bounty: X out in 0:30" so you are already sitting on the attack
  page, then "X is OUT" when the timer ends. "Hunted" marks a target whose last hospital stay was
  another player's hit: expect a race. Tick ✓ once you collect: the target hides until the board
  changes for them (a claim or a new bounty), or 24 h at most.
- **Paid hits on a faction:** every member under one rule, for a faction that pays you in a ranked
  war to keep its enemy in hospital (re-hit each member as they walk out) or to hit offliners
  (members who cannot fight back and score the same).
  Hittable members are listed lowest level first.
- **Traders:** the "Online or idle" rule alerts when a trader lands or leaves hospital and is around.
- **Hunting abroad:** a target in another country only counts when you are in that country too, so
  in Japan the list is everyone you can hit in Japan.
- **Attack-page bar:** on the attack screen, a bar shows your energy and life and whether *this*
  target still meets its terms, so you never make an illegal hit. For a bounty target it reads
  "HOSPITALIZE to claim $X": leaving or mugging pays nothing.
- **Hit log, with proof:** each time a target clears its terms, one line is kept: who, when (TCT),
  their status, activity and early-discharge state, and the terms. With a **Limited** key, every
  hit you make on a watched target is logged too, from your own attack list: result, time, Fair
  Fight, the attack log link, the state they were in when they last cleared the terms, and the
  terms. A bounty hit says whether it paid. Each line has a copy button; **Copy all** takes the
  lot for a client. Contract rows also show the target's activity ("Idle 3m") at a glance.
- **Claims tally:** a bounty hospitalisation ticks the row for you and the status line shows
  "~$1.2m from 4 claims today".
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
- Polling: 30 s for players who are out, every 5 min for a long hospital stay (a revive can end it
  early), 60 s inside the last half hour, 15 s inside the last 5 minutes and 2 s in the last minute.
  The release-second polls are never starved by a long list: the poll most overdue for its own
  pace goes first. The board itself is read once a minute.
- It only polls while a torn.com tab is open and the radar is on.

## What it will not do

It never clicks, submits, changes pages or attacks for you, and it will not get an auto-attack mode.

Not included from paid radars: illegal-hit evidence images and device sync.

## API key terms

| | |
|---|---|
| Data storage | Settings and the hit log stay in this browser's script storage |
| Data sharing | None. Torn requests go only to api.torn.com. With an FFScouter key set, that key, target ids and the pool filters go to ffscouter.com |
| Purpose | Read player, faction, bounty and bar data for your own alerts, and your own attack list for the proof log |
| Key storage and sharing | Stored locally, never shared |
| Key access level | Limited for the proof log and claims tally; Minimal for the attack bar and chain timer; Public for everything else |

## Licence

All rights reserved. Use is by allowlisted Torn id only; no copying, redistribution or removal of the check. See LICENSE.

## Develop

`npm test` runs the pure logic tests with Node's built-in runner. There is no build step.

Fan-made, not affiliated with Torn or FFScouter.
