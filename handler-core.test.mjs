// The lifecycle canon, § B (a PR event) and the automatic arrows of § A, one test per arrow.
// Run: node --test handler-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, doneLine, branchKey, pathsOf, routeOf, rungOf, DONE_STATES, previousTag, prNumbersOf, tagIntents, decideTag, hasReleaseTags, tagOf, townCodePath } from './handler-core.mjs';

const pr = (o = {}) => ({ repo: 'postmark-town/postmark-office', number: 51, base: 'train/2026-w43', draft: false, merged: false, author: 'bevel-starforge[bot]', mergedBy: 'wright-starforge', files: null, headRef: 'wld-51-fix', title: 'A fix', body: 'Fixes the thing.\n\ncloses WLD-51\n', ...o });
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
// STAR-141: Postmark Linear's CORE and CON teams are ours too; until this, "closes CORE-25" (office #935) read as no done line.
test('done line: CORE and CON are our teams (STAR-141)', () => {
  assert.deepEqual(doneLine('closes CORE-25'), { kind: 'closes', key: 'CORE-25' });
  assert.deepEqual(doneLine('closes CON-6'), { kind: 'closes', key: 'CON-6' });
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
test('B: a ready PR with no done line: the hint offers closes or unsure, never "part N of M" (TRACKING; Darko 2026-11-05)', () => {
  const r = run('ready_for_review', { body: 'no line here' }, issue('Building'));
  assert.equal(r.check.ok, false);
  assert.match(r.check.summary, /closes WLD-51/); assert.match(r.check.summary, /unsure · WLD-51/);
  assert.doesNotMatch(r.check.summary, /part \d+ of \d+ ·/);
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
test("B: Gated's note names who lifts it, its gater or named lifter; the rest of the red zone keeps 'only a hand' (STAR-172)", () => {
  const g = run('closed', { merged: true }, issue('Gated')).note;
  assert.match(g, /whoever put it into Gated, or the lifter its Gate line names, moves it out once the gate is met: linear-plan move WLD-51 "<state>", with the evidence/);
  assert.doesNotMatch(g, /only a hand/);
  for (const s of ['Needs a Sitting', "Darko's Call"]) assert.match(run('closed', { merged: true }, issue(s)).note, /red zone: only a hand moves it out/);
});
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
// A ready PR moves its issue to In Review only when it finishes it (Darko 2026-10-21 11:34): closes, or the last part.
test('B: opened ready, closes → In Review', () => assert.equal(run('opened', { body: 'closes WLD-51' }, issue('Building')).move, 'In Review'));
test('B: opened ready, the last part (2 of 2) → In Review', () => {
  assert.equal(run('opened', { body: 'part 2 of 2 · WLD-51' }, issue('Building')).move, 'In Review');
  assert.equal(run('ready_for_review', { body: 'part 3 of 3 · WLD-51' }, issue('Building')).move, 'In Review');
});
test('B: opened ready, an earlier part (1 of 3) → no move (more PRs coming)', () => {
  assert.equal(run('opened', { body: 'part 1 of 3 · WLD-51' }, issue('Building')).move, null);
  assert.equal(run('ready_for_review', { body: 'part 2 of 3 · WLD-51' }, issue('Building')).move, null);
});
// WLD-97 (2026-11-13): a ready PR that doesn't finish its issue takes it from Queued to Building, as a draft would;
// only from Queued (Wright 16:05: Ready isn't picked yet), never to In Review, never backwards
test('B: ready, not finishing, from Queued → Building (the world#295 case)', () => {
  for (const e of ['opened', 'ready_for_review']) for (const body of ['part 1 of 3 · WLD-51', 'unsure · WLD-51', 'fixes it']) assert.equal(run(e, { body }, issue('Queued')).move, 'Building', `${e} · ${body}`);
});
test('B: ready, not finishing, from Ready or Backlog → no move (picking is Darko\'s)', () => {
  for (const s of ['Ready', 'Backlog']) assert.equal(run('ready_for_review', { body: 'part 1 of 3 · WLD-51' }, issue(s)).move, null, s);
});
test('B: ready, not finishing, never backwards and never to In Review', () => {
  for (const s of ['In Review', 'On the Train', 'Shipped']) assert.equal(run('ready_for_review', { body: 'part 1 of 3 · WLD-51' }, issue(s)).move, null, s);
});
test('B: ready and finishing, from Queued → In Review (unchanged)', () => assert.equal(run('opened', { body: 'closes WLD-51' }, issue('Queued')).move, 'In Review'));
test('B: opened ready, unsure → no move (the world#266 case: WLD-25 stayed Building)', () => {
  const r = decide({ event: 'opened', pr: pr({ repo: 'postmark-town/postmark-world', number: 266, base: 'main', author: 'wright-starforge', headRef: 'wld-25-named-creature', body: 'unsure · WLD-25' }), issue: issue('Building', 'WLD-25') });
  assert.equal(r.move, null);
  assert.equal(r.note, null);
  assert.equal(r.check.ok, true);
  assert.equal(run('ready_for_review', { body: 'unsure · WLD-51' }, issue('Building')).move, null);
});
test('B: opened ready with no done line → no move, and its check fails', () => {
  const r = run('opened', { body: 'fixes it' }, issue('Building'));
  assert.equal(r.move, null);
  assert.equal(r.check.ok, false);
});
test('A: a draft still opens to Building, whatever its done line', () => {
  for (const body of ['closes WLD-51', 'part 1 of 3 · WLD-51', 'unsure · WLD-51', '']) assert.equal(run('opened', { draft: true, body }, issue('Queued')).move, 'Building', body);
});
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
// Until 2026-11-23 this asserted "no move; Hotfixed is set at its tag" (Wright's 10-14 hold). TRACKING's Awaiting Settlement
// row is law (Wright, 2026-11-23 08:39 EST, on Rivet's POS-1189 FAULT): a hotfix merged to main is Awaiting Settlement until its tag.
test('B: merged, closes, office → main → a hotfix: Awaiting Settlement now, Hotfixed at its tag (TRACKING)', () => {
  for (const s of ['Building', 'In Review']) {
    const r = run('closed', { merged: true, base: 'main', headRef: 'hotfix/pos-1189-x' }, issue(s));
    assert.equal(r.move, 'Awaiting Settlement', s);
    assert.match(r.note, /as a hotfix and closes WLD-51; it goes live at its hand tag, so WLD-51 is Awaiting Settlement until then and Hotfixed at the tag/, s);
  }
});
test('B: an office train into main (the ship) is not a hotfix: no move, and no hotfix note to hold a train copy', () => {
  const r = run('closed', { merged: true, base: 'main', headRef: 'train/2026-w49' }, issue('In Review'));
  assert.equal(r.move, null); assert.doesNotMatch(r.note, /as a hotfix/); assert.match(r.note, /is the ship, not a hotfix/);
});
test('B: merged, closes, town → train → On the Train', () => assert.equal(run('closed', { merged: true, repo: 'postmark-town/postmark' }, issue('In Review')).move, 'On the Train'));
// until 2026-11-18 this asserted "town → main → a hotfix note, no move" (Hotfixed at a tag). The town has no release tag
// (SHIPPING § 1: its main is live on merge), so a town hotfix is Hotfixed at the merge (STAR-203, Truey's finding 1).
test('B: merged, closes, town → main → live on merge: town code is Hotfixed (the town has no tag)', () => assert.equal(run('closed', { merged: true, repo: 'postmark-town/postmark', base: 'main', files: ['tools/x.mjs'] }, issue('In Review')).move, 'Hotfixed'));
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
  assert.equal(rungOf('jetto-starforge[bot]'), 'jetto');
  assert.equal(rungOf('app/jetto-starforge'), 'jetto');
  assert.equal(rungOf('app/facet-starforge'), 'facet'); // CORE-88: Facet's PRs read "not one of our authors"
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
test('#6: a site PR into main touching code is a hotfix: Awaiting Settlement, with the hotfix note', () => {
  const r = run('closed', { merged: true, repo: 'postmark-town/postmark-site', base: 'main', files: ['tools/a.mjs', 'src/lib/b.ts'] }, issue('In Review'));
  assert.equal(r.move, 'Awaiting Settlement'); assert.match(r.note, /as a hotfix/);
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
  assert.equal(r.move, 'Awaiting Settlement'); assert.match(r.note, /as a hotfix/);
});
test('#3: a part merge moves Queued or In Review to Building, never Backlog or Ready', () => {
  for (const [s, to] of [['Queued', 'Building'], ['In Review', 'Building'], ['Building', null], ['Backlog', null], ['Ready', null]]) {
    assert.equal(run('closed', { merged: true, body: 'part 1 of 2 · WLD-51' }, issue(s)).move, to, s);
  }
});
// ── STAR-203 (STAR-197 piece 2; Darko 2026-11-18 09:16 EST: "Go on all three") ──
// LAW (TRACKING § A PR's done line): "a lane writes no `part N of M` (Darko, 2026-11-05). An issue that is really several
// pieces gets a sub-issue per piece." The `linear` check refuses it; closes and unsure work as before.
test('STAR-203: a ready PR with "part N of M" fails its check, naming the rule and the fix', () => {
  for (const e of ['opened', 'ready_for_review', 'edited']) {
    for (const body of ['part 2 of 3 · WLD-51', 'part 1 of 2 · WLD-51', 'part 3 of 3 · WLD-51']) {
      const r = run(e, { body }, issue('Building'));
      assert.equal(r.check.ok, false, `${e} · ${body}`);
      assert.match(r.check.summary, /one piece, one sub-issue/, `${e} · ${body}`);
      assert.match(r.check.summary, /split it into a sub-issue and say `closes <ID>`/, `${e} · ${body}`);
    }
  }
});
test('STAR-203: the refusal does not need the issue to be found, nor a Linear read (WLD-97 sat stuck behind a part line)', () => {
  assert.equal(run('ready_for_review', { body: 'part 2 of 3 · WLD-51' }, null).check.ok, false);
});
test('STAR-203 control: closes and unsure still pass the check on a ready PR', () => {
  for (const body of ['closes WLD-51', 'unsure · WLD-51']) assert.equal(run('ready_for_review', { body }, issue('Building')).check.ok, true, body);
});
test('STAR-203 control: a draft with "part N of M" is not failed yet (a draft needs its line only when ready)', () => {
  assert.equal(run('opened', { draft: true, body: 'part 1 of 2 · WLD-51' }, issue('Queued')).check.ok, true);
});
// Done-type states (TRACKING § The states: Shipped and Hotfixed are kinds of Done): nothing the handler does moves an
// issue out of one. The invariant already held (the red zone, LANE_STATES and forward() each stop it); this pins it.
const DONE_TYPES = ['Hotfixed', 'Shipped', 'Done'];
test('STAR-203 control: no event, done line or repo moves an issue out of a done-type state', () => {
  const events = [['opened', { draft: true }], ['opened', {}], ['ready_for_review', {}], ['converted_to_draft', { draft: true }], ['edited', {}], ['closed', { merged: true }], ['closed', { merged: true, base: 'main' }], ['closed', { merged: true, repo: 'postmark-town/postmark-world', base: 'main' }], ['closed', { merged: true, repo: 'postmark-town/postmark-telemetry', base: 'main' }]];
  for (const s of DONE_TYPES) for (const [e, p] of events) for (const body of ['closes WLD-51', 'part 1 of 2 · WLD-51', 'part 2 of 2 · WLD-51', 'unsure · WLD-51', 'no line']) {
    assert.equal(run(e, { ...p, body }, issue(s)).move, null, `${s} · ${e} · ${body}`);
  }
});
test('STAR-203: a train copy merging for an issue already Hotfixed/Shipped/Done leaves it, and the note says so (no "set it by hand")', () => {
  for (const s of DONE_TYPES) {
    const r = run('closed', { merged: true, base: 'train/2026-w47', body: 'closes WLD-51' }, issue(s));
    assert.equal(r.move, null, s);
    assert.match(r.note, new RegExp(`already ${s}`), s);
    assert.match(r.note, /never moves a done state back/, s);
    assert.match(r.note, /train copy/, s);
    assert.doesNotMatch(r.note, /set it by hand/, s);
  }
});
test('STAR-203 control: the other states keep the old note (a Backlog issue is still set by hand)', () => {
  assert.match(run('closed', { merged: true }, issue('Backlog')).note, /is in Backlog, not Building or In Review, so the merge moved nothing; set it by hand/);
});

// ── STAR-203 rule 2: a train copy of a hotfix that is on main does not move the issue (the POS-1081 shape) ──
// POS-1081 (2026-11-18): hotfix #1122 merged to main (a note, state held In Review); its train copy #1123 merged into the
// train at 05:17 and the handler moved In Review → On the Train, so a hotfix read as riding the train until its tag.
// RULED (Wright for Darko's STAR-197 go, 2026-11-18): a `closes X` PR into train/* must not move X while a `closes X` PR
// has already merged into main; X stays, with a note, and Hotfixed comes at the tag.
const hotfixNoteFor = (key = 'WLD-51', o = {}) => decide({ event: 'closed', pr: pr({ merged: true, base: 'main', ...o }), issue: issue('In Review', key) }).note;
const withNotes = (state, notes, key = 'WLD-51') => ({ ...issue(state, key), handlerNotes: notes });
test('STAR-203: the POS-1081 shape: hotfix merged to main, then its train copy merges: the issue stays, with the note', () => {
  for (const repo of ['postmark-town/postmark-office', 'postmark-town/postmark-site']) {
    const hot = hotfixNoteFor('WLD-51', { repo, number: 1122, files: ['src/lib/b.ts'] });
    assert.match(hot, /as a hotfix/, repo);
    const r = run('closed', { merged: true, repo, number: 1123, base: 'train/2026-w47' }, withNotes('In Review', [hot]));
    assert.equal(r.move, null, repo);
    assert.match(r.note, /a train copy of a hotfix that's on main; Hotfixed comes at the tag/, repo);
    assert.match(r.note, /stays in In Review/, repo);
    // and where the hotfix's merge has already moved it (2026-11-23): the train copy holds it there with the same note,
    // not "not Building or In Review … set it by hand"
    const r2 = run('closed', { merged: true, repo, number: 1123, base: 'train/2026-w47' }, withNotes('Awaiting Settlement', [hot]));
    assert.equal(r2.move, null, repo);
    assert.match(r2.note, /a train copy of a hotfix that's on main; Hotfixed comes at the tag\. WLD-51 stays in Awaiting Settlement/, repo);
  }
});
// Truey on 2262779 (blocking): the town has no release tag (its main is live on merge, SHIPPING § 1), so rule 4's hold and
// "Hotfixed comes at the tag" are office and site only. RULED (2026-11-18): a town hotfix is Hotfixed at the merge.
const TOWN = 'postmark-town/postmark';
test('STAR-203: a town hotfix (a closes PR into main from a non-train branch) is Hotfixed at the merge, with the live-on-merge note', () => {
  for (const state of ['Building', 'In Review']) {
    const r = run('closed', { merged: true, repo: TOWN, base: 'main', headRef: 'hotfix/pos-1010-hand-self-burn', body: 'closes WLD-51', files: ['tools/hand-self-burn.mjs', 'test/hand-self-burn.test.mjs'] }, issue(state));
    assert.equal(r.move, 'Hotfixed', state);
    assert.match(r.note, /live on merge \(the town has no release tag\)/, state);
  }
});
// RULED (lead, 2026-11-18): in the town a merge into main is live on merge, so the state follows what merged: code
// (anything under tools/, or any .mjs/.js file; SHIPPING § 1 town row) is Hotfixed; docs only is Shipped, with a note.
// Real shapes: town #4681 (closes POS-1019, HEARTH-SETUP.md only) is Shipped; a tools/ change is Hotfixed.
test('STAR-203: a docs-only town PR into main (the #4681 shape: HEARTH-SETUP.md) is Shipped at the merge, with the docs note', () => {
  for (const state of ['Building', 'In Review']) {
    const r = run('closed', { merged: true, repo: TOWN, base: 'main', headRef: 'wld-51-hearth-setup', body: 'closes WLD-51', files: ['HEARTH-SETUP.md'] }, issue(state));
    assert.equal(r.move, 'Shipped', state);
    assert.match(r.note, /live on merge \(docs; TRACKING: a live-on-merge docs PR is Shipped\)/, state);
  }
});
test('STAR-203: a town PR with any code path is Hotfixed, however many docs it also touches', () => {
  for (const files of [['tools/x.mjs'], ['tools/readme-gen.sh'], ['lib/y.js'], ['HEARTH-SETUP.md', 'tools/x.mjs'], ['docs/a.md', 'src/z.mjs']]) {
    assert.equal(run('closed', { merged: true, repo: TOWN, base: 'main', headRef: 'wld-51-x', body: 'closes WLD-51', files }, issue('In Review')).move, 'Hotfixed', files.join(','));
  }
  for (const files of [['HEARTH-SETUP.md'], ['docs/a.md', 'letters/b.json'], ['mytools/x.md']]) {
    assert.equal(run('closed', { merged: true, repo: TOWN, base: 'main', headRef: 'wld-51-x', body: 'closes WLD-51', files }, issue('In Review')).move, 'Shipped', files.join(','));
  }
});
// RULED (Wright, 2026-11-18 10:25 EST): the town's law files count as code (SHIPPING § 1 town row: "the law files"), so one
// merged to the town's main is Hotfixed, not Shipped. The #4650 shape: PROMISES.md only.
test('STAR-203: a town PR touching only a law file (the #4650 shape: PROMISES.md) is Hotfixed; HEARTH-SETUP.md (#4681) is still Shipped', () => {
  const at = (files) => run('closed', { merged: true, repo: TOWN, base: 'main', headRef: 'wld-51-x', body: 'closes WLD-51', files }, issue('In Review')).move;
  for (const f of ['PROMISES.md', 'ECONOMY-DIALS.json', 'TOWN-RULES.md', 'STAMPS.md', 'MAIL.md', 'JOINING.md', 'quest-registry.json', 'CONTRIBUTING.md', 'CONTRIBUTING-AGENTS.md']) assert.equal(at([f]), 'Hotfixed', f);
  assert.equal(at(['HEARTH-SETUP.md']), 'Shipped');
  assert.equal(at(['HEARTH-SETUP.md', 'PROMISES.md']), 'Hotfixed');
});
test('STAR-203 control: the law-file list is exact, repo-root, case-sensitive paths; look-alikes are docs', () => {
  for (const f of ['docs/PROMISES.md', 'PROMISES.md.bak', 'promises.md', 'README.md', 'GLOSSARY.md', 'WITNESS.md', 'FIRST-DAY.md', 'docs/CONTRIBUTING.md', 'MYCONTRIBUTING.md']) assert.equal(townCodePath(f), false, f);
});
test('STAR-203 control: town files that could not be read (or an empty list) are a note for a hand, never a guess', () => {
  for (const files of [null, []]) {
    const r = run('closed', { merged: true, repo: TOWN, base: 'main', headRef: 'wld-51-x', body: 'closes WLD-51', files }, issue('In Review'));
    assert.equal(r.move, null); assert.match(r.note, /could not be read/);
  }
});
// Truey on af233a8 (the missing test): the notes the handler wrote for a town main merge before this PR read
// "postmark#N merged to main as a hotfix and closes X; ...". They must not hold a town train copy: no tag will come.
test('STAR-203: an old-format town hotfix note ("postmark#N ... closes X;") does not hold a town train copy', () => {
  const oldTownNote = 'postmark#4661 merged to main as a hotfix and closes WLD-51; Hotfixed is set at its tag by whoever cuts it (SHIPPING § 5). The state holds.';
  const r = run('closed', { merged: true, repo: TOWN, base: 'train/2026-w47' }, withNotes('In Review', [oldTownNote]));
  assert.equal(r.move, 'On the Train');
  // control: the same words under an office name do hold an office train copy (the guard is the repo, not the text)
  const office = run('closed', { merged: true, base: 'train/2026-w47' }, withNotes('In Review', [oldTownNote.replace('postmark#', 'postmark-office#')]));
  assert.equal(office.move, null);
});
test('STAR-203: then a town train copy meets an already-Hotfixed issue and leaves it', () => {
  const r = run('closed', { merged: true, repo: TOWN, base: 'train/2026-w47' }, issue('Hotfixed'));
  assert.equal(r.move, null); assert.match(r.note, /already Hotfixed/);
});
test('STAR-203: a town train copy with no hotfix first is not held (no tag will come to free it)', () => {
  const hot = hotfixNoteFor('WLD-51', { repo: 'postmark-town/postmark-site', files: ['src/lib/b.ts'] });
  assert.equal(run('closed', { merged: true, repo: TOWN, base: 'train/2026-w47' }, withNotes('In Review', [hot])).move, 'On the Train');
  assert.equal(run('closed', { merged: true, repo: TOWN, base: 'train/2026-w47' }, issue('In Review')).move, 'On the Train');
});
test('STAR-203 control: a town PR into main from a train branch is not a hotfix, and a town hotfix on a done-type or red-zone issue moves nothing', () => {
  const f = ['tools/x.mjs'];
  assert.equal(run('closed', { merged: true, repo: TOWN, base: 'main', headRef: 'train/2026-w47', body: 'closes WLD-51', files: f }, issue('In Review')).move, null);
  assert.equal(run('closed', { merged: true, repo: TOWN, base: 'main', headRef: 'hotfix/x', body: 'closes WLD-51', files: f }, issue('Hotfixed')).move, null);
  assert.equal(run('closed', { merged: true, repo: TOWN, base: 'main', headRef: 'hotfix/x', body: 'closes WLD-51', files: f }, issue('Gated')).move, null);
  assert.equal(run('closed', { merged: true, repo: TOWN, base: 'main', headRef: 'hotfix/x', body: 'closes WLD-51', files: f }, issue('Backlog')).move, null);
  assert.equal(run('closed', { merged: true, repo: TOWN, base: 'main', headRef: 'hotfix/x', body: 'closes WLD-51', files: ['HEARTH-SETUP.md'] }, issue('Shipped')).move, null);
});
// Truey finding 3: the hold reads this repo's own hotfix note only
test("STAR-203: a site hotfix's note does not hold an office train PR for the same issue (the note starts with its own repo and PR)", () => {
  const siteNote = hotfixNoteFor('WLD-51', { repo: 'postmark-town/postmark-site', number: 900, files: ['src/lib/b.ts'] });
  assert.match(siteNote, /^postmark-site#900 merged to main as a hotfix/);
  assert.equal(run('closed', { merged: true, repo: 'postmark-town/postmark-office', base: 'train/2026-w47' }, withNotes('In Review', [siteNote])).move, 'On the Train');
  assert.equal(run('closed', { merged: true, repo: 'postmark-town/postmark-site', base: 'train/2026-w47' }, withNotes('In Review', [siteNote])).move, null);
  // and "postmark" (the town) never reads a "postmark-office#" note as its own
  const officeNote = hotfixNoteFor('WLD-51', { number: 7 });
  assert.equal(run('closed', { merged: true, repo: TOWN, base: 'train/2026-w47' }, withNotes('In Review', [officeNote])).move, 'On the Train');
});
test('STAR-203 control: the same train merge with no hotfix on main moves the issue to On the Train as before', () => {
  assert.equal(run('closed', { merged: true, base: 'train/2026-w47' }, withNotes('In Review', [])).move, 'On the Train');
  assert.equal(run('closed', { merged: true, base: 'train/2026-w47' }, issue('In Review')).move, 'On the Train');
});
test('STAR-203 control: a hotfix note for another issue, or an unrelated note, does not hold this one', () => {
  const other = hotfixNoteFor('WLD-9', { headRef: 'wld-9-fix', body: 'closes WLD-9' });
  for (const notes of [[other], ['Unsure (postmark-office#7 merged): does it finish WLD-51? Asking up the ladder.']]) {
    assert.equal(run('closed', { merged: true, base: 'train/2026-w47' }, withNotes('In Review', notes)).move, 'On the Train');
  }
});
test('STAR-203 control: a hotfix elsewhere does not hold a world merge (main is its own route)', () => {
  const hot = hotfixNoteFor('WLD-51', { files: ['src/lib/b.ts'] });
  assert.equal(run('closed', { merged: true, repo: 'postmark-town/postmark-world', base: 'main' }, withNotes('In Review', [hot])).move, 'Awaiting Settlement');
});

// ── STAR-203 rule 3: the takes-main PR carries no issue by design ──
// RULED (2026-11-18): a PR whose head branch starts `take-main/`, or whose title is `train/<week> takes main at <sha>`,
// passes the done-line check with a note and the handler moves nothing for it (office #1127 was red on `linear / linear`
// only for that).
test('STAR-203: a take-main/ branch or a "takes main at" title passes the check on a ready PR, with no move', () => {
  for (const o of [{ headRef: 'take-main/2026-w47', body: '' }, { headRef: 'train-takes-main', title: 'train/2026-w47 takes main at 9be687d1f', body: '' }, { headRef: 'take-main/2026-w47', body: 'closes WLD-51' }]) {
    for (const e of ['opened', 'ready_for_review', 'edited']) {
      const r = run(e, o, issue('Building'));
      assert.equal(r.check.ok, true, `${e} · ${JSON.stringify(o)}`);
      assert.match(r.check.summary, /takes main/, JSON.stringify(o));
      assert.equal(r.move, null); assert.equal(r.note, null);
    }
    const m = run('closed', { ...o, merged: true, base: 'train/2026-w47' }, issue('In Review'));
    assert.equal(m.move, null); assert.equal(m.note, null); assert.equal(m.ladder, null);
  }
});
test('STAR-203 control: other PRs with no done line still fail; a lookalike title or branch is not exempt', () => {
  for (const o of [{ headRef: 'wld-51-fix', body: '' }, { headRef: 'take-main-ish', body: '' }, { headRef: 'wld-51-fix', title: 'train/2026-w47 takes main later', body: '' }, { headRef: 'wld-51-fix', title: 'fix: takes main at the door', body: '' }]) {
    assert.equal(run('ready_for_review', o, issue('Building')).check.ok, false, JSON.stringify(o));
  }
});

// ── STAR-203 rule 1: Hotfixed at the tag (the handler's tag mode, on a fixture commit range) ──
// RULED (2026-11-18): the callers gain `on: push: tags: ['release/*']`; the handler lists the PRs merged into main
// between the previous release/* tag and this one (their commit subjects name the PR), and moves each one's `closes X`
// (or `unsure · X`) issue to Hotfixed unless it is already done-type, with a note naming the tag.
const TAGS = ['release/2026-w47.9', 'release/2026-w47.10', 'release/2026-w47.17', 'release/2026-w47.18', 'release/2026-w48', 'release/2026-w46.3', 'release/2026-w47', 'release/not-a-week', 'hotfix/x'];
test('tag mode: the previous release tag, by week then patch number (w47.9 < w47.10, w47 < w47.1)', () => {
  assert.equal(previousTag('release/2026-w47.18', TAGS), 'release/2026-w47.17');
  assert.equal(previousTag('release/2026-w47.10', TAGS), 'release/2026-w47.9');
  assert.equal(previousTag('release/2026-w48', TAGS), 'release/2026-w47.18');
  assert.equal(previousTag('release/2026-w47', TAGS), 'release/2026-w46.3');
  assert.equal(previousTag('release/2026-w46.3', TAGS), null);
  assert.equal(previousTag('release/2026-w47.9', ['release/2026-w47.9', 'release/2026-w47']), 'release/2026-w47');
  assert.equal(previousTag('release/not-a-week', TAGS), null);
});
test('tag mode: the PR numbers a commit range names (squash and merge subjects), once each, in order', () => {
  const commits = ['Fix the doorstep (#1122)', 'Merge pull request #1123 from postmark-town/hotfix/x', 'chore: no pr here', 'Fix the doorstep (#1122)', 'Revert "x (#9)" (#1130)', 'merge (#12) trailing'].map((message) => ({ commit: { message: `${message}\n\nbody (#999)` } }));
  assert.deepEqual(prNumbersOf(commits), [1122, 1123, 1130]);
});
const hf = (o = {}) => ({ repo: 'postmark-town/postmark-office', number: 1122, base: 'main', headRef: 'hotfix/pos-1081-doorstep', draft: false, merged: true, author: 'jetto-starforge[bot]', mergedBy: 'wright-starforge', title: 'POS-1081: the doorstep', body: 'closes WLD-51', ...o });
test('tag mode: which PRs in the range name an issue: hotfixes into main by ours, merged by ours, with a done line', () => {
  const prs = [
    hf({ number: 1122 }),                                                              // a hotfix
    hf({ number: 1124, body: 'unsure · POS-5', headRef: 'pos-5-x' }),                    // an unsure still counts
    hf({ number: 1125, body: 'part 2 of 2 · POS-6', headRef: 'pos-6-x' }),               // the last part finishes
    hf({ number: 1126, body: 'part 1 of 2 · POS-7', headRef: 'pos-7-x' }),               // an earlier part does not
    hf({ number: 1127, headRef: 'train/2026-w47', body: 'closes POS-8' }),               // the ship PR carries a train, not an issue
    hf({ number: 1128, headRef: 'take-main/2026-w47', body: '' }),                       // takes-main
    hf({ number: 1129, base: 'train/2026-w47', body: 'closes POS-9' }),                  // the train copy
    hf({ number: 1130, merged: false, body: 'closes POS-10' }),                          // not merged
    hf({ number: 1131, author: 'a-stranger', body: 'closes POS-11' }),                   // not ours
    hf({ number: 1132, mergedBy: 'a-stranger', body: 'closes POS-12' }),                 // merged by someone not ours
    hf({ number: 1133, repo: 'postmark-town/postmark-world', body: 'closes WLD-13' }),   // world's main is its own route
    hf({ number: 1134, body: 'no line', headRef: 'misc' }),                              // no done line: never guessed
    hf({ number: 1135, body: 'closes POS-14', headRef: 'pos-99-other' }),                // done line and branch disagree
  ];
  assert.deepEqual(tagIntents({ tag: 'release/2026-w47.18', prs }).map((i) => [i.key, i.pr.number]), [['WLD-51', 1122], ['POS-5', 1124], ['POS-6', 1125]]);
});
test('tag mode: two PRs naming one issue make one intent', () => {
  assert.equal(tagIntents({ tag: 't', prs: [hf({ number: 1 }), hf({ number: 2 })] }).length, 1);
});
const tagOn = (state, notes = []) => decideTag({ tag: 'release/2026-w47.18', pr: hf(), issue: { ...issue(state), handlerNotes: notes } });
test('tag mode: the issue moves to Hotfixed from the states a hotfix waits in, with a note naming the tag and the PR', () => {
  for (const s of ['Building', 'In Review', 'On the Train', 'Awaiting Settlement']) {
    const r = tagOn(s);
    assert.equal(r.move, 'Hotfixed', s);
    assert.match(r.note, /release\/2026-w47\.18/, s); assert.match(r.note, /postmark-office#1122/, s); assert.match(r.note, /WLD-51/, s);
  }
});
test('tag mode: a done-type (or closed-out) issue is left alone, with no note', () => {
  for (const s of [...DONE_STATES, 'Canceled', 'Duplicate']) { const r = tagOn(s); assert.equal(r.move, null, s); assert.equal(r.note, null, s); }
});
test('tag mode: the red zone is never left, and a state no hotfix waits in is a note for a hand', () => {
  for (const s of ['Gated', 'Needs a Sitting', "Darko's Call"]) { const r = tagOn(s); assert.equal(r.move, null, s); assert.match(r.note, new RegExp(`stays in ${s}`), s); }
  for (const s of ['Backlog', 'Ready', 'Queued']) { const r = tagOn(s); assert.equal(r.move, null, s); assert.match(r.note, /set it by hand/, s); }
  assert.deepEqual(tagOn('Some New State').move, null);
});
test('tag mode: a missing issue is nothing', () => assert.deepEqual(decideTag({ tag: 't', pr: hf(), issue: null }), { move: null, note: null }));
test('tag mode: only office and site cut release tags (the town is live on merge and has none)', () => {
  assert.equal(hasReleaseTags('postmark-town/postmark-office'), true);
  assert.equal(hasReleaseTags('postmark-town/postmark-site'), true);
  for (const r of ['postmark-town/postmark', 'postmark-town/postmark-world', 'postmark-town/postmark-telemetry', 'postmark-town/postmark-blueprints']) assert.equal(hasReleaseTags(r), false, r);
  assert.deepEqual(tagIntents({ tag: 't', prs: [hf({ repo: 'postmark-town/postmark' })] }), []);
});
// Truey on 2262779: an `unsure` is "no move" (TRACKING § The rhythm); at the tag it is a note only.
test('tag mode: an unsure hotfix at the tag is a note only, whatever the state; a closes for the same issue wins', () => {
  const u = hf({ number: 1124, body: 'unsure · POS-5', headRef: 'pos-5-x' });
  assert.deepEqual(tagIntents({ tag: 't', prs: [u] }).map((i) => [i.key, i.kind]), [['POS-5', 'unsure']]);
  for (const s of ['Building', 'In Review', 'On the Train', 'Awaiting Settlement', 'Gated', 'Backlog']) {
    const r = decideTag({ tag: 'release/2026-w47.18', pr: u, kind: 'unsure', issue: { ...issue(s, 'POS-5') } });
    assert.equal(r.move, null, s); assert.match(r.note, /release\/2026-w47\.18 is live and contains postmark-office#1124, an unsure hotfix for POS-5/, s);
  }
  assert.equal(decideTag({ tag: 't', pr: u, kind: 'unsure', issue: issue('Hotfixed', 'POS-5') }).note, null);
  const both = [u, hf({ number: 1126, body: 'closes POS-5', headRef: 'pos-5-y' })];
  assert.deepEqual(tagIntents({ tag: 't', prs: both }).map((i) => [i.key, i.pr.number, i.kind]), [['POS-5', 1126, 'closes']]);
  assert.deepEqual(tagIntents({ tag: 't', prs: [...both].reverse() }).map((i) => [i.key, i.pr.number, i.kind]), [['POS-5', 1126, 'closes']]);
});
test('tag mode: a push event is a release tag only for refs/tags/release/*, and not a deletion', () => {
  assert.equal(tagOf({ ref: 'refs/tags/release/2026-w47.18' }), 'release/2026-w47.18');
  for (const ev of [{ ref: 'refs/tags/v1' }, { ref: 'refs/heads/main' }, { ref: 'refs/tags/release/2026-w47.18', deleted: true }, { pull_request: {}, ref: 'refs/tags/release/x' }, {}]) assert.equal(tagOf(ev), null, JSON.stringify(ev));
});

test('#4: a done line inside an HTML comment is not a done line', () => {
  assert.equal(doneLine('<!-- closes WLD-51 -->').error, 'no done line');
  // an unclosed comment hides everything after it from a reader, so the handler doesn't read it either
  assert.equal(doneLine('fixes stuff\n<!--\ncloses WLD-51').error, 'no done line');
  assert.equal(doneLine('closes WLD-51\n<!-- a note never closed').kind, 'closes');
  assert.equal(doneLine('<!--\ncloses WLD-51\n-->\nunsure · WLD-51').kind, 'unsure');
});
