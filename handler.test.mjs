// The handler end to end on GitHub event fixtures, against a stub Linear (canon § B, with the I/O in).
// Run: node --test handler.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle as handleWith, prOf } from './handler.mjs';
const handle = (ev, L, opts) => handleWith(ev, { linear: L, files: async () => ['tools/x.mjs'] }, opts);

const STATES = ['Backlog', 'Ready', 'Queued', 'Building', 'In Review', 'On the Train', 'Awaiting Settlement', 'Hotfixed', 'Shipped', 'Gated', 'Needs a Sitting', "Darko's Call"];

function stubLinear(issues) {
  const calls = [];
  return {
    calls,
    issue: async (key) => (issues[key] ? { id: `id-${key}`, key, teamId: 't', delegateId: null, handlerNotes: [], ...issues[key] } : null),
    stateId: async (_t, name) => (STATES.includes(name) ? `s-${name}` : null),
    setState: async (id, s) => { calls.push(['state', id, s]); },
    comment: async (id, body) => { calls.push(['comment', id, body]); },
    setDelegate: async (id, u) => { calls.push(['delegate', id, u]); },
  };
}

const event = (action, o = {}) => ({
  action,
  repository: { full_name: o.repo ?? 'postmark-town/postmark-office' },
  pull_request: {
    number: 51, draft: o.draft ?? false, merged: o.merged ?? false, body: o.body ?? 'closes WLD-51',
    base: { ref: o.base ?? 'train/2026-w43' }, head: { ref: o.head ?? 'wld-51-fix', repo: { full_name: o.headRepo ?? o.repo ?? 'postmark-town/postmark-office' } },
    user: { login: o.author ?? 'bevel-starforge[bot]' },
    merged_by: o.merged ? { login: o.mergedBy ?? 'wright-starforge' } : null,
  },
});

test('event → pr: a fork is never ours, whoever wrote it', () => {
  assert.equal(prOf(event('opened', { headRepo: 'someone/postmark-office', author: 'wright-starforge' })).author, null);
  assert.equal(prOf(event('opened')).author, 'bevel-starforge[bot]');
});
test('draft opened on a Queued issue → Building, one state write', async () => {
  const L = stubLinear({ 'WLD-51': { state: 'Queued' } });
  const r = await handle(event('opened', { draft: true, body: '' }), L);
  assert.deepEqual(L.calls, [['state', 'id-WLD-51', 's-Building']]);
  assert.deepEqual(r.did, ['WLD-51: Queued → Building']);
});
test("red zone: Darko's Call is never left; one note, and a redelivered event adds none", async () => {
  const L = stubLinear({ 'WLD-51': { state: "Darko's Call" } });
  const r = await handle(event('closed', { merged: true }), L);
  assert.equal(L.calls.length, 1); assert.equal(L.calls[0][0], 'comment');
  const again = stubLinear({ 'WLD-51': { state: "Darko's Call", handlerNotes: [r.note] } });
  await handle(event('closed', { merged: true }), again);
  assert.deepEqual(again.calls, []);
});
test('merged into train, closes → On the Train', async () => {
  const L = stubLinear({ 'WLD-51': { state: 'In Review' } });
  await handle(event('closed', { merged: true }), L);
  assert.deepEqual(L.calls, [['state', 'id-WLD-51', 's-On the Train']]);
});
test('unsure at merge: no state write, one note, and the delegate to the lane’s lead (Bevel’s Linear app user)', async () => {
  const L = stubLinear({ 'WLD-51': { state: 'In Review' } });
  const r = await handle(event('closed', { merged: true, body: 'unsure · WLD-51' }), L);
  assert.deepEqual(L.calls, [['comment', 'id-WLD-51', r.note], ['delegate', 'id-WLD-51', '71ffbdfa-48c0-47c4-90d1-e13c77eceb69']]);
});
test('unsure at merge, already delegated to that lead: the note only', async () => {
  const L = stubLinear({ 'WLD-51': { state: 'In Review', delegateId: '71ffbdfa-48c0-47c4-90d1-e13c77eceb69' } });
  const r = await handle(event('closed', { merged: true, body: 'unsure · WLD-51' }), L);
  assert.deepEqual(L.calls.map((c) => c[0]), ['comment']);
  assert.match(r.did.at(-1), /already delegated to bevel/);
});
test('an in-session lane’s unsure goes to Wright’s Linear user', async () => {
  const L = stubLinear({ 'WLD-51': { state: 'In Review' } });
  await handle(event('closed', { merged: true, body: 'unsure · WLD-51', author: 'wright-starforge' }), L);
  assert.deepEqual(L.calls.at(-1), ['delegate', 'id-WLD-51', 'fadf18ad-dd89-407a-a73a-3864bae90545']);
});
test('a stranger citing our issue: Linear is not even read', async () => {
  let reads = 0;
  const L = { ...stubLinear({ 'WLD-51': { state: 'In Review' } }), issue: async () => { reads += 1; return null; } };
  await handle(event('closed', { merged: true, author: 'foundoutanyway' }), L);
  assert.equal(reads, 0);
});
test('dry run: says what it would do, writes nothing', async () => {
  const L = stubLinear({ 'WLD-51': { state: 'Building' } });
  const r = await handle(event('ready_for_review'), L, { dry: true });
  assert.deepEqual(L.calls, []); assert.deepEqual(r.did, ['WLD-51: Building → In Review']);
});
test('a ready PR with no done line: the check fails, Linear still moves by the branch', async () => {
  const L = stubLinear({ 'WLD-51': { state: 'Building' } });
  const r = await handle(event('ready_for_review', { body: 'no line' }), L);
  assert.equal(r.check.ok, false);
  assert.deepEqual(L.calls, [['state', 'id-WLD-51', 's-In Review']]);
});

test('#3: a stranger\'s event never makes a Linear client (no mint)', async () => {
  let made = 0;
  await handleWith(event('closed', { merged: true, author: 'foundoutanyway' }), { linear: async () => { made += 1; return null; } });
  assert.equal(made, 0);
});
test('#3: our author with no issue key: no client either', async () => {
  let made = 0;
  await handleWith(event('opened', { body: 'misc', head: 'chore-x' }), { linear: async () => { made += 1; return null; } });
  assert.equal(made, 0);
});
test('#5: a deleted fork (no head repo) is never ours', () => {
  const ev = event('opened');
  ev.pull_request.head.repo = null;
  assert.equal(prOf(ev).author, null);
});
test('#6: a site PR into main reads its files and ships when they are all live-on-merge paths', async () => {
  const L = stubLinear({ 'WLD-51': { state: 'In Review' } });
  let asked = null;
  await handleWith(event('closed', { merged: true, repo: 'postmark-town/postmark-site', base: 'main' }), { linear: L, files: async (repo, n) => { asked = `${repo}#${n}`; return ['public/renditions/a.png']; } });
  assert.equal(asked, 'postmark-town/postmark-site#51');
  assert.deepEqual(L.calls, [['state', 'id-WLD-51', 's-Shipped']]);
});
test('#6: a files read that fails is a note, never a guess', async () => {
  const L = stubLinear({ 'WLD-51': { state: 'In Review' } });
  const r = await handleWith(event('closed', { merged: true, repo: 'postmark-town/postmark-site', base: 'main' }), { linear: L, files: async () => { throw new Error('403'); } });
  assert.equal(r.move, null); assert.match(r.note, /could not be read/);
});
test('#8: a dry run says the note, and a repeat says "note already there"', async () => {
  const first = stubLinear({ 'WLD-51': { state: 'Gated' } });
  const r = await handle(event('ready_for_review'), first, { dry: true });
  assert.deepEqual(first.calls, []); assert.match(r.did[0], /note "/);
  const again = stubLinear({ 'WLD-51': { state: 'Gated', handlerNotes: [r.note] } });
  const r2 = await handle(event('closed', { merged: true }), again, { dry: true });
  assert.deepEqual(r2.did, ['WLD-51: note already there']);
});
