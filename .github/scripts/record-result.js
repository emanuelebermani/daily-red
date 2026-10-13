// Turns a "Daily Red #N result" issue into one line of results.txt.
// Input comes from the environment (never interpolated into a shell):
//   ISSUE_BODY, ISSUE_LOGIN, RESULTS_FILE (optional)
// Writes ok, reason and line to $GITHUB_OUTPUT.
'use strict';
const fs = require('fs');

const START = Date.UTC(2026, 9, 13); // challenge #1
const FILE = process.env.RESULTS_FILE || 'results.txt';

function output(values) {
  const lines = Object.entries(values).map(([k, v]) => k + '=' + String(v).replace(/[\r\n]+/g, ' '));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  else console.log(lines.join('\n'));
}

function parse(body) {
  const text = String(body || '').replace(/\r/g, '');
  const at = text.indexOf('daily-red-result');
  if (at < 0) return null;
  const fields = {};
  for (const raw of text.slice(at).split('\n').slice(1)) {
    const line = raw.trim();
    if (line.startsWith('```')) break;
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) fields[m[1]] = m[2].trim();
  }
  return fields;
}

function check(f, login) {
  if (!f) return 'The issue does not contain a Daily Red result block.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date || '')) return 'The date is missing or not in YYYY-MM-DD form.';
  const [y, mo, d] = f.date.split('-').map(Number);
  const when = Date.UTC(y, mo - 1, d);
  if (Number.isNaN(when)) return 'The date is not valid.';
  const expectedDay = Math.round((when - START) / 86400000) + 1;
  if (expectedDay < 1) return 'That date is before challenge #1.';
  if (when > Date.now() + 2 * 86400000) return 'That date is in the future.';
  if (Number(f.day) !== expectedDay) return 'The challenge number does not match the date.';
  if (!/^[A-Z0-9 .!?]{1,7}$/.test(f.player || '')) return 'The player name must be 1 to 7 letters, numbers or . ! ?';
  if (!['WIN', 'LOSS'].includes(f.outcome)) return 'The outcome must be WIN or LOSS.';
  const turns = Number(f.turns), standing = Number(f.standing), down = Number(f.red_down);
  if (!Number.isInteger(turns) || turns < 1 || turns > 999) return 'The turn count is not valid.';
  if (!Number.isInteger(standing) || standing < 0 || standing > 6) return 'The standing count is not valid.';
  if (!Number.isInteger(down) || down < 0 || down > 6) return "Red's knocked out count is not valid.";
  if (f.outcome === 'WIN' && (down !== 6 || standing < 1)) return 'A win needs all six of Red\'s Pokemon down and at least one of yours standing.';
  if (f.outcome === 'LOSS' && standing !== 0) return 'A loss means none of your Pokemon are standing.';
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login || '')) return 'Unknown GitHub user.';
  return null;
}

const HEADER = [
  'DAILY RED RESULTS',
  'One line per player per day, added automatically when a result is submitted from the game.',
  '',
  'DATE        DAY    PLAYER   GITHUB                  RESULT  TURNS  STANDING  RED DOWN',
];

function main() {
  const login = process.env.ISSUE_LOGIN;
  const f = parse(process.env.ISSUE_BODY);
  const problem = check(f, login);
  if (problem) return output({ ok: false, reason: problem, line: '' });

  let text = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : HEADER.join('\n') + '\n';
  const dupe = text.split('\n').some(l => l.startsWith(f.date + ' ') && l.toLowerCase().includes(' @' + login.toLowerCase() + ' '));
  if (dupe) return output({ ok: false, reason: 'There is already a result from @' + login + ' for ' + f.date + '. Only the first one counts.', line: '' });

  const line = [
    f.date.padEnd(11),
    ('#' + f.day).padEnd(6),
    f.player.padEnd(8),
    ('@' + login).padEnd(23),
    f.outcome.padEnd(7),
    String(f.turns).padEnd(6),
    (f.standing + '/6').padEnd(9),
    f.red_down + '/6',
  ].join(' ');
  if (!text.endsWith('\n')) text += '\n';
  fs.writeFileSync(FILE, text + line + '\n');
  output({ ok: true, reason: '', line });
}

if (require.main === module) main();
module.exports = { parse, check };
