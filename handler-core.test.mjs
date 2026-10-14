// The lifecycle canon, § B (a PR event) and the automatic arrows of § A, one test per arrow.
// Run: node --test handler-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, doneLine, branchKey, pathsOf, routeOf, rungOf } from './handler-core.mjs';

const pr = (o = {}) => ({ repo: 'postmark-town/postmark-office', number: 51, base: 'train/2026-w43', draft: false, merged: false, author: 'bevel-starforge[bot]', mergedBy: 'wright-starforge', files: null, headRef: 'wld-51-fix', body: 'Fixes the thing.\n\ncloses WLD-51\n', ...o });
const issue = (state, key = 'WLD-51') => ({ key, state });
const run = (event, p, i) => decide({ event, pr: pr(p), issue: i });

// ── the done line ──
test('done line: closes', () => assert.deepEqual(doneLine('closes WLD-51'), { kind: 'closes', key: 'WLD-51' }));
test('done line: part N of M', () => assert.deepEqual(doneLine('part 1 of 2 · WLD-51'), { kind: 'part', n: 1, m: 2, key: 'WLD-51' }));
test('done line: unsure', () => assert.deepEqual(doneLine('unsure · POS-7'), { kind: 'unsure', key: 'POS-7' }));
test('done line: tolerant of case, a bullet, backticks and a plain separator', () => {
  assert.deepEqual(doneLine('- `Closes wld-51`'), { kind: 'closes', key: 'WLD-51' });
  assert.deepEqual(doneLine('Part 2 of 3 - POS-9'), { kind: 'part', n: 2, m: 3, key: 'POS-9' });
});
test('done line: missing', () => assert.equal(doneLine('fixes stuff\nrefs WLD-51').error, 'no done line'));
test('done line: in prose is not a done line', () => assert.equal(doneLine('this closes WLD-51 I think').error, 'no done line'));
test('done line: two different ones are refused', () => assert.match(doneLine('closes WLD-51\nunsure · WLD-51').error, /exactly one/));
test('done line: the same one twice is one', () => assert.equal(doneLine('closes WLD-51\n\ncloses WLD-51').kind, 'closes'));
test('done line: an impossible part is refused', () => assert.match(doneLine('part 3 of 2 · WLD-51').error, /not a part/));
test('done line: another team is not ours', () => assert.equal(doneLine('closes ABC-1').error, 'no done line'));
test('done line: the PR template left unedited is no done line', async () => {
  const { readFileSync } = await import('node:fs');
  assert.equal(doneLine(readFileSync(new URL('./caller/pull_request_template.md', import.meta.url), 'utf8')).error, 'no done line');
});
test('branch key (house rule 7)', () => {
  assert.equal(branchKey('wld-9-own-home-in-bare-read'), 'WLD-9');
  assert.equal(branchKey('pos-516'), 'POS-516');
  assert.equal(branchKey('feature/wld-9'), null);
});

// ── § B: issue linked? ──
test('B: no linked issue → nothing on Linear', () => {
  const r = run('opened', { body: 'no line', headRef: 'misc-cleanup' }, null);
  assert.equal(r.move, null); assert.equal(r.note, null);
});
test('B: the issue is not on Linear → nothing, and the check says so', () => {
  const r = run('ready_for_review', {}, null);
  assert.equal(r.move, null); assert.match(r.check.summary, /not found/);
});
test('B: a PR from outside our authors never moves Linear', () => {
  const r = run('closed', { merged: true, author: 'a-stranger' }, issue('In Review'));
  assert.equal(r.move, null); assert.equal(r.note, null);
});

// ── § B: the red zone ──
for (const state of ['Gated', 'Needs a Sitting', "Darko's Call"]) {
  for (const [event, p] of [['opened', { draft: true }], ['opened', {}], ['ready_for_review', {}], ['closed', { merged: true }]]) {
    test(`B: red zone: ${state}, ${event}${p.draft ? ' (draft)' : ''}${p.merged ? ' (merged)' : ''} → no move, one note`, () => {
      const r = run(event, p, issue(state));
      assert.equal(r.move, null);
      assert.match(r.note, new RegExp(`stays in ${state.replace("'", "'")}`));
    });
  }
}
test("B: the WLD-51 case: five PR events, Darko's Call never left", () => {
  for (const e of ['opened', 'ready_for_review', 'closed']) assert.equal(run(e, { merged: e === 'closed' }, issue("Darko's Call")).move, null);
});

// ── § A/B: opened and ready ──
test('A: a draft PR (house rule 7, the lane\'s first act) → Building', () => {
  assert.equal(run('opened', { draft: true, body: '' }, issue('Queued')).move, 'Building');
  assert.equal(run('opened', { draft: true, body: '' }, issue('Ready')).move, 'Building');
});
test('B: opened ready → In Review', () => assert.equal(run('opened', {}, issue('Building')).move, 'In Review'));
test('B: marked ready → In Review (rule 7: In Review is the handoff)', () => assert.equal(run('ready_for_review', {}, issue('Building')).move, 'In Review'));
test('A: never backwards: a new PR on a row already On the Train leaves it', () => assert.equal(run('opened', { draft: true }, issue('On the Train')).move, null));
test('A: already In Review: no move', () => assert.equal(run('ready_for_review', {}, issue('In Review')).move, null));
test('B: other events (synchronize, edited, closed unmerged) move nothing', () => {
  for (const [e, p] of [['synchronize', {}], ['edited', {}], ['closed', { merged: false }]]) assert.equal(run(e, p, issue('In Review')).move, null);
});
test('A: a FIX (the PR turned back to draft) → In Review back to Building', () => assert.equal(run('converted_to_draft', { draft: true }, issue('In Review')).move, 'Building'));
test('A: turned back to draft anywhere but In Review → no move', () => {
  for (const s of ['Building', 'On the Train', 'Queued']) assert.equal(run('converted_to_draft', { draft: true }, issue(s)).move, null);
});
test("B: turned back to draft in the red zone → no move, the red-zone note", () => {
  const r = run('converted_to_draft', { draft: true }, issue("Darko's Call"));
  assert.equal(r.move, null); assert.match(r.note, /stays in Darko's Call/);
});

// ── § B: the check (the done line is required) ──
test('B: a ready PR without a done line fails its check', () => {
  const r = run('ready_for_review', { body: 'no line' }, issue('Building'));
  assert.equal(r.check.ok, false); assert.match(r.check.summary, /closes WLD-51/);
});
test('B: a draft without a done line passes (it is needed when ready)', () => assert.equal(run('opened', { draft: true, body: '' }, issue('Queued')).check.ok, true));

// ── § B: merged, the done line ──
test('B: merged, closes, office → train → On the Train', () => assert.equal(run('closed', { merged: true }, issue('In Review')).move, 'On the Train'));
test('B: merged, closes, site → train → On the Train', () => assert.equal(run('closed', { merged: true, repo: 'postmark-town/postmark-site' }, issue('In Review')).move, 'On the Train'));
test('B: merged, closes, world → main → Awaiting Settlement', () => assert.equal(run('closed', { merged: true, repo: 'postmark-town/postmark-world', base: 'main' }, issue('In Review')).move, 'Awaiting Settlement'));
test('B: merged, closes, office → main → a hotfix: no move; Hotfixed is set at its tag (Wright\'s ruling)', () => {
  const r = run('closed', { merged: true, base: 'main' }, issue('In Review'));
  assert.equal(r.move, null); assert.match(r.note, /as a hotfix .* Hotfixed is set at its tag/);
});
test('B: merged, closes, town → train → On the Train', () => assert.equal(run('closed', { merged: true, repo: 'postmark-town/postmark' }, issue('In Review')).move, 'On the Train'));
test('B: merged, closes, town → main → a hotfix note, no move', () => assert.equal(run('closed', { merged: true, repo: 'postmark-town/postmark', base: 'main' }, issue('In Review')).move, null));
test('B: merged, closes, blueprints or telemetry → main → Shipped (live on merge)', () => {
  for (const repo of ['postmark-town/postmark-blueprints', 'postmark-town/postmark-telemetry']) assert.equal(run('closed', { merged: true, repo, base: 'main' }, issue('In Review')).move, 'Shipped');
});
test('B: merged, closes, world-spire (no route) → no move, one note', () => {
  const r = run('closed', { merged: true, repo: 'postmark-town/postmark-world-spire', base: 'main' }, issue('In Review'));
  assert.equal(r.move, null); assert.match(r.note, /no route is ruled/);
});
test('B: an untrusted PR citing an issue in the red zone: no move and no note (no noise from strangers)', () => {
  const r = run('closed', { merged: true, author: 'a-stranger' }, issue("Darko's Call"));
  assert.equal(r.move, null); assert.equal(r.note, null);
});
test('B: merged, part 1 of 2 → Building (stays, more PRs coming)', () => assert.equal(run('closed', { merged: true, body: 'part 1 of 2 · WLD-51' }, issue('In Review')).move, 'Building'));
test('B: merged, part 1 of 2 while already Building → stays', () => assert.equal(run('closed', { merged: true, body: 'part 1 of 2 · WLD-51' }, issue('Building')).move, null));
test('B: merged, the last part (2 of 2) finishes it → routed', () => assert.equal(run('closed', { merged: true, body: 'part 2 of 2 · WLD-51' }, issue('In Review')).move, 'On the Train'));
test('B: merged, unsure → no move; climbs the ladder with one note', () => {
  const r = run('closed', { merged: true, body: 'unsure · WLD-51' }, issue('In Review'));
  assert.equal(r.move, null); assert.equal(r.ladder, 'bevel'); assert.match(r.note, /^Unsure/);
});
test('B: merged without a done line → an unsure (never a guessed done)', () => {
  const r = run('closed', { merged: true, body: 'no line' }, issue('In Review'));
  assert.equal(r.move, null); assert.equal(r.ladder, 'bevel'); assert.match(r.note, /no done line/);
});

// ── routes ──
test('routes: only the ruled ones', () => {
  assert.deepEqual(routeOf('postmark-town/postmark-office', 'train/2026-w43'), { to: 'On the Train' });
  assert.deepEqual(routeOf('postmark-world', 'train/x'), { to: null, why: 'unrouted' });
  assert.deepEqual(routeOf('postmark-town/postmark-telemetry', 'train/x'), { to: null, why: 'unrouted' });
  assert.deepEqual(routeOf('postmark-town/postmark-office', 'wld-51-fix'), { to: null, why: 'unrouted' });
  assert.deepEqual(routeOf('postmark-town/postmark-office', 'main'), { to: null, why: 'hotfix' });
});

// ── the ladder's first rung, by author ──
test('rungs: a pod App is its lead; Wright for in-session and Keemin; a meep app or resident is nobody', () => {
  assert.equal(rungOf('rivet-starforge[bot]'), 'rivet');
  assert.equal(rungOf('app/bevel-starforge'), 'bevel');
  assert.equal(rungOf('wright-starforge'), 'wright');
  assert.equal(rungOf('keeminlee'), 'wright');
  for (const who of ['rei-starforge', 'postmark-architect-meep', 'foundoutanyway', undefined]) assert.equal(rungOf(who), null);
});
test('B: an in-session lane’s unsure goes to Wright', () => {
  assert.equal(run('closed', { merged: true, body: 'unsure · WLD-51', author: 'wright-starforge' }, issue('In Review')).ladder, 'wright');
});

// ── review-handler (10-14) ──
test('#2: a merge whose done line names another issue than its branch moves nothing, notes it, and fails the check', () => {
  const r = run('closed', { merged: true, headRef: 'wld-51-fix', body: 'closes POS-9' }, issue('In Review', 'POS-9'));
  assert.equal(r.move, null); assert.match(r.note, /names POS-9 but the branch names WLD-51/); assert.equal(r.check.ok, false);
});
test('#2: a mismatch on a ready PR moves nothing either', () => {
  assert.equal(run('ready_for_review', { headRef: 'wld-51-fix', body: 'closes WLD-9' }, issue('Building', 'WLD-9')).move, null);
});
test('#2: closes moves only from Building or In Review: a Backlog issue gets a note, not Shipped', () => {
  const r = run('closed', { merged: true, repo: 'postmark-town/postmark-telemetry', base: 'main' }, issue('Backlog'));
  assert.equal(r.move, null); assert.match(r.note, /is in Backlog, not Building or In Review/);
});
test('#2: a merge by someone not ours moves nothing and notes nothing', () => {
  const r = run('closed', { merged: true, mergedBy: 'a-stranger' }, issue('In Review'));
  assert.equal(r.move, null); assert.equal(r.note, null);
});
test('#2: a merge by keeminlee or a pod App counts', () => {
  assert.equal(run('closed', { merged: true, mergedBy: 'keeminlee' }, issue('In Review')).move, 'On the Train');
});
test('#4: a state the handler does not know is never moved out of (a curly apostrophe)', () => {
  assert.equal(run('closed', { merged: true }, issue('Darko’s Call')).move, null);
  assert.equal(run('ready_for_review', {}, issue('Some New State')).move, null);
});
test('#6: a site PR into main touching only live-on-merge paths is Shipped at merge', () => {
  assert.equal(run('closed', { merged: true, repo: 'postmark-town/postmark-site', base: 'main', files: ['tools/fetch-town.mjs', 'src/data/postmark/x.json'] }, issue('In Review')).move, 'Shipped');
});
test('#6: a site PR into main touching code is a hotfix: a note, no move', () => {
  const r = run('closed', { merged: true, repo: 'postmark-town/postmark-site', base: 'main', files: ['tools/a.mjs', 'src/lib/b.ts'] }, issue('In Review'));
  assert.equal(r.move, null); assert.match(r.note, /as a hotfix/);
});
test('#6: a site PR into main whose files could not be read: a note, no move', () => {
  const r = run('closed', { merged: true, repo: 'postmark-town/postmark-site', base: 'main', files: null }, issue('In Review'));
  assert.equal(r.move, null); assert.match(r.note, /could not be read/);
});
test('#7: the red-zone note is the same words for every event of one PR', () => {
  const notes = [['opened', { draft: true }], ['ready_for_review', {}], ['closed', { merged: true }]].map(([e, p]) => run(e, p, issue('Gated')).note);
  assert.equal(new Set(notes).size, 1);
});

// ── review-handler leftovers (10-14) ──
test('#1: a rename counts under both names: code moved into tools/ is not live-only', () => {
  const files = pathsOf([{ filename: 'tools/Card.astro', previous_filename: 'src/components/Card.astro', status: 'renamed' }]);
  assert.deepEqual(files, ['tools/Card.astro', 'src/components/Card.astro']);
  const r = run('closed', { merged: true, repo: 'postmark-town/postmark-site', base: 'main', files }, issue('In Review'));
  assert.equal(r.move, null); assert.match(r.note, /as a hotfix/);
});
test('#3: a part merge moves Queued or In Review to Building, never Backlog or Ready', () => {
  for (const [s, to] of [['Queued', 'Building'], ['In Review', 'Building'], ['Building', null], ['Backlog', null], ['Ready', null]]) {
    assert.equal(run('closed', { merged: true, body: 'part 1 of 2 · WLD-51' }, issue(s)).move, to, s);
  }
});
test('#4: a done line inside an HTML comment is not a done line', () => {
  assert.equal(doneLine('<!-- closes WLD-51 -->').error, 'no done line');
  assert.equal(doneLine('<!--\ncloses WLD-51\n-->\nunsure · WLD-51').kind, 'unsure');
});
