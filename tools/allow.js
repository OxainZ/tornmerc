// Adds Torn ids to the allowlist in tornmerc.user.js:  node tools/allow.js 123456 234567
// Remove one by editing the Merc.ALLOWED line. Release afterwards (bump @version + Merc.VERSION, npm run meta, commit, push).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '..', 'tornmerc.user.js');
const src = fs.readFileSync(file, 'utf8');
const m = /(\tMerc\.ALLOWED = \[)([^\]]*)(\];)/.exec(src);
if (!m) throw new Error('no Merc.ALLOWED line');
const have = m[2].split(',').map((x) => Number(x.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
const add = process.argv.slice(2).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
if (!add.length) { console.log(`allowed: ${have.join(', ') || 'nobody'}`); process.exit(0); }
const all = [...new Set(have.concat(add))].sort((a, b) => a - b);
fs.writeFileSync(file, src.replace(m[0], `${m[1]}${all.join(', ')}${m[3]}`));
console.log(`allowed: ${all.join(', ')}`);
