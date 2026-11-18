// The handler end to end on GitHub event fixtures, against a stub Linear (canon § B, with the I/O in).
// Run: node --test handler.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle as handleWith, handleTag, prOf, tagPrsWith } from './handler.mjs';
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
// Darko 2026-10-21 11:34: a ready PR moves its issue only when its done line finishes it (closes, or the last part);
// with no line the handler never guesses "done", so the issue the branch names holds where it is
test('a ready PR with no done line: the check fails, and the issue the branch names holds its state', async () => {
  const L = stubLinear({ 'WLD-51': { state: 'Building' } });
  const r = await handle(event('ready_for_review', { body: 'no line' }), L);
  assert.equal(r.check.ok, false);
  assert.deepEqual(L.calls.filter((c) => c[0] === 'state'), []);
});
test('a ready PR that closes its issue moves it to In Review', async () => {
  const L = stubLinear({ 'WLD-51': { state: 'Building' } });
  await handle(event('ready_for_review', { body: 'closes WLD-51' }), L);
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
// ── STAR-203: a takes-main PR never reads Linear ──
test('STAR-203: a takes-main PR (branch or title) passes with no Linear client made', async () => {
  for (const o of [{ head: 'take-main/2026-w47', body: '' }, { head: 'take-main/2026-w47', body: 'closes WLD-51' }, { head: 'x', body: 'closes WLD-51', title: 'train/2026-w47 takes main at 9be687d1f' }]) {
    let made = 0;
    const ev = event('opened', o); ev.pull_request.title = o.title ?? 'x';
    const r = await handleWith(ev, { linear: async () => { made += 1; return null; } });
    assert.equal(made, 0); assert.equal(r.check.ok, true); assert.match(r.check.summary, /takes main/);
  }
});

// ── STAR-203: the town's merge into main is live on merge; the handler reads the PR's files ──
test('STAR-203: a docs-only town PR into main reads its files and is Shipped; a tools/ one is Hotfixed; the train\'s own is never read', async () => {
  const town = { repo: 'postmark-town/postmark', base: 'main', merged: true, head: 'wld-51-hearth' };
  const docs = stubLinear({ 'WLD-51': { state: 'In Review' } });
  let asked = null;
  await handleWith(event('closed', town), { linear: docs, files: async (repo, n) => { asked = `${repo}#${n}`; return ['HEARTH-SETUP.md']; } });
  assert.equal(asked, 'postmark-town/postmark#51');
  assert.deepEqual(docs.calls.map((c) => c.slice(0, 3)).filter((c) => c[0] === 'state'), [['state', 'id-WLD-51', 's-Shipped']]);
  const code = stubLinear({ 'WLD-51': { state: 'In Review' } });
  await handleWith(event('closed', town), { linear: code, files: async () => ['tools/mint.mjs'] });
  assert.deepEqual(code.calls.filter((c) => c[0] === 'state'), [['state', 'id-WLD-51', 's-Hotfixed']]);
  let reads = 0;
  await handleWith(event('closed', { ...town, head: 'train/2026-w47' }), { linear: stubLinear({ 'WLD-51': { state: 'In Review' } }), files: async () => { reads += 1; return []; } });
  assert.equal(reads, 0);
  const none = stubLinear({ 'WLD-51': { state: 'In Review' } });
  await handleWith(event('closed', town), { linear: none, files: async () => { throw new Error('403'); } });
  assert.deepEqual(none.calls.filter((c) => c[0] === 'state'), []);
});

// ── STAR-203: Hotfixed at the tag, on a fixture commit range through a fake GitHub ──
const REPO = 'postmark-town/postmark-office';
const apiPr = (n, o = {}) => ({ number: n, draft: false, merged: o.merged ?? true, title: o.title ?? `PR ${n}`, body: o.body ?? 'closes WLD-51',
  base: { ref: o.base ?? 'main' }, head: { ref: o.head ?? 'hotfix/x', repo: { full_name: REPO } }, user: { login: o.author ?? 'jetto-starforge[bot]' }, merged_by: { login: 'wright-starforge' } });
function fakeApi(over = {}) {
  const served = [];
  const routes = {
    [`/repos/${REPO}/git/matching-refs/tags/release/`]: ['release/2026-w47.16', 'release/2026-w47.17', 'release/2026-w47.18', 'release/2026-w47.9'].map((t) => ({ ref: `refs/tags/${t}` })),
    [`/repos/${REPO}/compare/release%2F2026-w47.17...release%2F2026-w47.18`]: { ahead_by: 4, commits: ['Fix the doorstep (#1122)', 'Merge pull request #1124 from postmark-town/pos-1081', 'Bump (#1125)', 'chore: no pr'].map((message) => ({ commit: { message } })) },
    [`/repos/${REPO}/pulls/1122`]: apiPr(1122),
    [`/repos/${REPO}/pulls/1124`]: apiPr(1124, { base: 'train/2026-w47', body: 'closes WLD-51', head: 'wld-51-copy' }),
    [`/repos/${REPO}/pulls/1125`]: apiPr(1125, { head: 'take-main/2026-w47', body: '', title: 'train/2026-w47 takes main at abc' }),
    ...over,
  };
  const api = async (path) => { served.push(path); if (!(path in routes)) throw new Error(`unexpected GitHub read ${path}`); return routes[path]; };
  api.served = served;
  return api;
}
const tagEvent = (tag = 'release/2026-w47.18', repo = REPO) => ({ ref: `refs/tags/${tag}`, repository: { full_name: repo } });

test('STAR-203 tag mode: the range between the previous release tag and this one yields the PRs its commits name', async () => {
  const api = fakeApi();
  const { prs, prev } = await tagPrsWith(api, REPO, 'release/2026-w47.18');
  assert.equal(prev, 'release/2026-w47.17');
  assert.deepEqual(prs.map((p) => [p.number, p.base]), [[1122, 'main'], [1124, 'train/2026-w47'], [1125, 'main']]);
  assert.ok(!api.served.some((p) => p.includes('1126')));
});
test('STAR-203 tag mode: a live tag sets the hotfix PR\'s issue to Hotfixed with a note naming the tag; the train copy and takes-main PRs add nothing', async () => {
  const L = stubLinear({ 'WLD-51': { state: 'In Review' } });
  const r = await handleTag(tagEvent(), { linear: L, tagPrs: (repo, tag) => tagPrsWith(fakeApi(), repo, tag) });
  assert.deepEqual(L.calls.map((c) => c.slice(0, 3)).map((c) => (c[0] === 'comment' ? ['comment', c[1]] : c)), [['state', 'id-WLD-51', 's-Hotfixed'], ['comment', 'id-WLD-51']]);
  assert.match(L.calls[1][2], /release\/2026-w47\.18 is live and contains postmark-office#1122/);
  assert.equal(r.did.length, 2);
});
test('STAR-203 tag mode: a re-run is quiet (already Hotfixed: nothing; the note is never posted twice)', async () => {
  const done = stubLinear({ 'WLD-51': { state: 'Hotfixed' } });
  await handleTag(tagEvent(), { linear: done, tagPrs: (repo, tag) => tagPrsWith(fakeApi(), repo, tag) });
  assert.deepEqual(done.calls, []);
  const first = stubLinear({ 'WLD-51': { state: 'In Review' } });
  const r = await handleTag(tagEvent(), { linear: first, tagPrs: (repo, tag) => tagPrsWith(fakeApi(), repo, tag) }, { dry: true });
  assert.deepEqual(first.calls, []); assert.match(r.did[0], /In Review → Hotfixed/);
});
test('STAR-203 tag mode: a Linear team without a Hotfixed state fails the step (after the other issues are done), and writes nothing', async () => {
  const L = { ...stubLinear({ 'WLD-51': { state: 'In Review' } }), stateId: async () => null };
  await assert.rejects(() => handleTag(tagEvent(), { linear: L, tagPrs: (repo, tag) => tagPrsWith(fakeApi(), repo, tag) }), /has no state "Hotfixed"/);
  assert.deepEqual(L.calls, []);
});
test('STAR-203 tag mode: no previous tag, or a ship-sized range, is a note and no Linear client', async () => {
  let made = 0;
  const linear = async () => { made += 1; return null; };
  const none = await handleTag(tagEvent('release/2026-w40'), { linear, tagPrs: (repo, tag) => tagPrsWith(fakeApi(), repo, tag) });
  assert.match(none.check.summary, /no previous release tag/);
  const big = fakeApi({ [`/repos/${REPO}/compare/release%2F2026-w47.17...release%2F2026-w47.18`]: { ahead_by: 400, commits: Array.from({ length: 250 }, () => ({ commit: { message: 'x (#1)' } })) } });
  const r = await handleTag(tagEvent(), { linear, tagPrs: (repo, tag) => tagPrsWith(big, repo, tag) });
  assert.match(r.check.summary, /too many to read as a hotfix/);
  assert.equal(made, 0);
});
// Truey on 2262779: matching-refs returns every match in one answer and ignores page and per_page (168 refs on every page
// in the live office), so a loop re-read them 30 times. It is read once, and the previous tag is found in that one answer.
test('STAR-203 tag mode: the release tag listing is read once, however many tags there are', async () => {
  const many = Array.from({ length: 168 }, (_, i) => ({ ref: `refs/tags/release/2026-w${String(10 + Math.floor(i / 10)).padStart(2, '0')}.${i % 10 + 1}` }));
  many.push({ ref: 'refs/tags/release/2026-w47.17' }, { ref: 'refs/tags/release/2026-w47.18' });
  const api = fakeApi({ [`/repos/${REPO}/git/matching-refs/tags/release/`]: many });
  const { prev } = await tagPrsWith(api, REPO, 'release/2026-w47.18');
  assert.equal(prev, 'release/2026-w47.17');
  assert.equal(api.served.filter((p) => p.includes('matching-refs')).length, 1);
  assert.ok(api.served.every((p) => !p.includes('page=')), 'no paged read');
});
// Truey finding 6: a "(#N)" in a subject that isn't a PR here is a 404 from pulls/N; it is skipped with a line, never a failure
test('STAR-203 tag mode: a (#N) that is not a PR (404) is skipped with a summary line, and the rest are read', async () => {
  const notFound = () => Object.assign(new Error('HTTP 404'), { status: 404 });
  const base = fakeApi();
  const api = async (path) => { if (path.endsWith('/pulls/1124')) throw notFound(); return base(path); };
  const r = await tagPrsWith(api, REPO, 'release/2026-w47.18');
  assert.deepEqual(r.prs.map((p) => p.number), [1122, 1125]);
  assert.match(r.skipped[0], /#1124 .* not a PR of postmark-town\/postmark-office \(404\); skipped/);
  const L = stubLinear({ 'WLD-51': { state: 'In Review' } }), lines = [];
  const out = await handleTag(tagEvent(), { linear: L, tagPrs: (repo, tag) => tagPrsWith(api, repo, tag) }, { log: (s) => lines.push(s) });
  assert.ok(lines.some((l) => /#1124 .*\(404\)/.test(l)));
  assert.match(out.check.summary, /1 skipped/);
  assert.deepEqual(L.calls.map((c) => c[0]), ['state', 'comment']);
});
test('STAR-203 tag mode: any other GitHub failure still fails the run (nothing moves on a half-read range)', async () => {
  const base = fakeApi();
  const api = async (path) => { if (path.endsWith('/pulls/1122')) throw Object.assign(new Error('HTTP 502'), { status: 502 }); return base(path); };
  await assert.rejects(() => tagPrsWith(api, REPO, 'release/2026-w47.18'), /502/);
});
test('STAR-203 tag mode: an unsure hotfix at the tag gets a note and no state write', async () => {
  const L = stubLinear({ 'POS-5': { state: 'In Review' } });
  const api = fakeApi({ [`/repos/${REPO}/pulls/1122`]: apiPr(1122, { body: 'unsure · POS-5', head: 'pos-5-x' }) });
  await handleTag(tagEvent(), { linear: L, tagPrs: (repo, tag) => tagPrsWith(api, repo, tag) });
  assert.deepEqual(L.calls.map((c) => c[0]), ['comment']);
  assert.match(L.calls[0][2], /an unsure hotfix for POS-5/);
});
test('STAR-203 tag mode: a repo with no release tags (the town, world) or a non-release ref never reads GitHub or Linear', async () => {
  const boom = () => { throw new Error('must not be called'); };
  for (const repo of ['postmark-town/postmark-world', 'postmark-town/postmark']) {
    const w = await handleTag(tagEvent('release/2026-w47.18', repo), { linear: boom, tagPrs: boom });
    assert.match(w.check.summary, /no release tags/, repo);
  }
  const v = await handleTag({ ref: 'refs/tags/v1', repository: { full_name: REPO } }, { linear: boom, tagPrs: boom });
  assert.match(v.check.summary, /not a release tag/);
});

test('#8: a dry run says the note, and a repeat says "note already there"', async () => {
  const first = stubLinear({ 'WLD-51': { state: 'Gated' } });
  const r = await handle(event('ready_for_review'), first, { dry: true });
  assert.deepEqual(first.calls, []); assert.match(r.did[0], /note "/);
  const again = stubLinear({ 'WLD-51': { state: 'Gated', handlerNotes: [r.note] } });
  const r2 = await handle(event('closed', { merged: true }), again, { dry: true });
  assert.deepEqual(r2.did, ['WLD-51: note already there']);
});
