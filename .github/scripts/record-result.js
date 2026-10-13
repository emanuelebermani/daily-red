// Turns "Daily Red #N result" issues into lines of results.txt.
// The workflow calls run() through actions/github-script. Every run handles all
// open result issues, oldest first, so a run that GitHub cancels or that fails
// to push is picked up by the next one.
//
// Local check of a single issue body:
//   ISSUE_BODY="$(cat body.txt)" ISSUE_LOGIN=octocat node .github/scripts/record-result.js
'use strict';
const fs = require('fs');

const START = Date.UTC(2026, 9, 13); // challenge #1
const FILE = process.env.RESULTS_FILE || 'results.txt';
const TITLE = 'Daily Red #';
const MAX_REROLLS = 5;

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

// Plain decimal integers only, so "1.0", "1e1" or "0x1" are refused rather than copied into the file.
const int = (s, max) => (/^\d{1,3}$/.test(s || '') && Number(s) <= max ? Number(s) : null);

function check(f, login) {
  if (!f) return 'The issue does not contain a Daily Red result block.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date || '')) return 'The date is missing or not in YYYY-MM-DD form.';
  const [y, mo, d] = f.date.split('-').map(Number);
  const when = Date.UTC(y, mo - 1, d);
  if (Number.isNaN(when)) return 'The date is not valid.';
  const expectedDay = Math.round((when - START) / 86400000) + 1;
  if (expectedDay < 1) return 'That date is before challenge #1.';
  if (when > Date.now() + 2 * 86400000) return 'That date is in the future.';
  if (int(f.day, 999) !== expectedDay) return 'The challenge number does not match the date.';
  if (!/^[A-Z0-9 .!?]{1,7}$/.test(f.player || '')) return 'The player name must be 1 to 7 letters, numbers or . ! ?';
  if (!['WIN', 'LOSS'].includes(f.outcome)) return 'The outcome must be WIN or LOSS.';
  const turns = int(f.turns, 999), standing = int(f.standing, 6), down = int(f.red_down, 6);
  if (turns === null || turns < 1) return 'The turn count is not valid.';
  if (standing === null) return 'The standing count is not valid.';
  if (down === null) return "Red's knocked out count is not valid.";
  if (f.rerolls !== undefined && int(f.rerolls, MAX_REROLLS) === null) return 'The reroll count must be 0 to ' + MAX_REROLLS + '.';
  if (f.outcome === 'WIN' && (down !== 6 || standing < 1)) return 'A win needs all six of Red\'s Pokemon down and at least one of yours standing.';
  if (f.outcome === 'LOSS' && standing !== 0) return 'A loss means none of your Pokemon are standing.';
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login || '')) return 'Unknown GitHub user.';
  return null;
}

const HEADER = [
  'DAILY RED RESULTS',
  'One line per player per day, added automatically when a result is submitted from the game.',
  '',
  'DATE        DAY    PLAYER   GITHUB                  RESULT  TURNS  STANDING  RED DOWN  REROLLS',
];

// Every value is written from its parsed form, never from the issue text.
function formatLine(f, login) {
  return [
    f.date.padEnd(11),
    ('#' + int(f.day, 999)).padEnd(6),
    f.player.padEnd(8),
    ('@' + login).padEnd(23),
    f.outcome.padEnd(7),
    String(int(f.turns, 999)).padEnd(6),
    (int(f.standing, 6) + '/6').padEnd(9),
    (int(f.red_down, 6) + '/6').padEnd(9),
    String(f.rerolls === undefined ? 0 : int(f.rerolls, MAX_REROLLS)),
  ].join(' ');
}

// Adds one issue's result to the text of results.txt.
// Returns { ok, reason, line, text, added }.
function record(text, body, login) {
  const f = parse(body);
  const problem = check(f, login);
  if (problem) return { ok: false, reason: problem, line: '', text, added: false };
  const line = formatLine(f, login);
  const lines = text.split('\n');
  // an earlier run wrote this line but did not get to close the issue
  if (lines.includes(line)) return { ok: true, reason: '', line, text, added: false };
  const dupe = lines.some(l => l.startsWith(f.date + ' ') && l.toLowerCase().includes(' @' + login.toLowerCase() + ' '));
  if (dupe) return { ok: false, reason: 'There is already a result from @' + login + ' for ' + f.date + '. Only the first one counts.', line: '', text, added: false };
  return { ok: true, reason: '', line, text: (text.endsWith('\n') ? text : text + '\n') + line + '\n', added: true };
}

function readResults() {
  return fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : HEADER.join('\n') + '\n';
}

async function run({ github, context, exec, core }) {
  const { owner, repo } = context.repo;
  const open = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'open', per_page: 100 });
  const issues = open.filter(i => !i.pull_request && i.title.startsWith(TITLE)).sort((a, b) => a.number - b.number);
  core.info(issues.length + ' open result issue(s)');
  if (!issues.length) return;

  await exec.exec('git', ['config', 'user.name', 'github-actions[bot]']);
  await exec.exec('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);

  let outcomes;
  for (let attempt = 1; ; attempt++) {
    const before = readResults();
    let text = before;
    outcomes = issues.map(issue => {
      const r = record(text, issue.body, issue.user.login);
      text = r.text;
      return { issue, ...r };
    });
    if (text === before) break;
    fs.writeFileSync(FILE, text);
    const added = outcomes.filter(o => o.added);
    const message = added.length === 1
      ? 'Add Daily Red result from @' + added[0].issue.user.login + ' (#' + added[0].issue.number + ')'
      : 'Add ' + added.length + ' Daily Red results (' + added.map(o => '#' + o.issue.number).join(', ') + ')';
    await exec.exec('git', ['add', FILE]);
    await exec.exec('git', ['commit', '-m', message]);
    if (await exec.exec('git', ['push', 'origin', 'HEAD:main'], { ignoreReturnCode: true }) === 0) break;
    if (attempt === 3) throw new Error('Could not push results.txt. The issues stay open and the next run retries them.');
    // main moved since checkout: start again from the latest results.txt
    await exec.exec('git', ['fetch', 'origin', 'main']);
    await exec.exec('git', ['reset', '--hard', 'origin/main']);
  }

  for (const o of outcomes) {
    const body = o.ok
      ? 'Recorded in results.txt:\n\n```text\n' + o.line + '\n```\n\nThanks for playing Daily Red!'
      : 'This result was not recorded: ' + o.reason;
    try {
      await github.rest.issues.createComment({ owner, repo, issue_number: o.issue.number, body });
      await github.rest.issues.update({ owner, repo, issue_number: o.issue.number, state: 'closed', state_reason: o.ok ? 'completed' : 'not_planned' });
    } catch (e) {
      core.warning('Could not reply to #' + o.issue.number + ': ' + e.message);
    }
  }
}

if (require.main === module) {
  const r = record(readResults(), process.env.ISSUE_BODY, process.env.ISSUE_LOGIN);
  console.log(r.ok ? r.line : 'not recorded: ' + r.reason);
}
module.exports = { parse, check, formatLine, record, run };
