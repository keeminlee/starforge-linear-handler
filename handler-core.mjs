// handler-core.mjs: the one automatic mover of Linear states (the lifecycle canon, § B; Darko's 10-14 sitting).
// Pure: it takes a PR event and the linked issue as it reads now, and says what to do. The workflow around it
// reads GitHub's event and Linear, then acts on the answer. Every arrow of canon § B is a test in handler-core.test.mjs.
//
//   decide({ event, pr, issue }) -> { move, note, ladder, check }   (pr.author is the PR's GitHub login)
//     move    the state to set, or null
//     note    one comment for the issue, or null (a red-zone refusal, a key mismatch, an unsure, a hotfix, or a
//             merge that could not be routed); one per PR, never per event
//     ladder  the rung an unsure goes to first (the lane's lead, or wright for an in-session lane), else null;
//             the caller delegates the issue to it, and the house's doorbell rings the new holder (rule 6)
//     check   { ok, summary } for the PR's own check run: a ready PR without a done line fails it

export const TEAMS = ['POS', 'WLD', 'CORE', 'CON'];
export const RED_ZONE = new Set(['Gated', 'Needs a Sitting', "Darko's Call"]);
const RANK = { Backlog: 0, Ready: 1, Queued: 1, Building: 2, 'In Review': 3, 'On the Train': 4, 'Awaiting Settlement': 4, Hotfixed: 5, Shipped: 5, Done: 5, Canceled: 5, Duplicate: 5 };

const KEY = `((?:${TEAMS.join('|')})-\\d+)`;
const SEP = '\\s*[·|:-]\\s*';
const LINES = [
  { kind: 'closes', re: new RegExp(`^\\s*closes\\s+${KEY}\\s*$`, 'i') },
  { kind: 'part', re: new RegExp(`^\\s*part\\s+(\\d+)\\s+of\\s+(\\d+)${SEP}${KEY}\\s*$`, 'i') },
  { kind: 'unsure', re: new RegExp(`^\\s*unsure${SEP}${KEY}\\s*$`, 'i') },
];

/** The done line of a PR body: { kind, key, n?, m? }, or { error } when there is none or more than one. */
export function doneLine(body) {
  const found = [];
  // an HTML comment is never a done line, only a visible line is (review-handler leftover #4); an unclosed one
  // runs to the end of the body, as a reader's renderer hides it
  const visible = String(body ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const raw of visible.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*>]\s+)?/, '').replace(/`/g, '');
    for (const { kind, re } of LINES) {
      const m = re.exec(line);
      if (!m) continue;
      if (kind === 'part') found.push({ kind, n: Number(m[1]), m: Number(m[2]), key: m[3].toUpperCase() });
      else found.push({ kind, key: m[1].toUpperCase() });
    }
  }
  if (!found.length) return { error: 'no done line' };
  const keys = new Set(found.map((f) => `${f.kind}|${f.key}|${f.n ?? ''}`));
  if (keys.size > 1) return { error: `${found.length} different done lines; a PR carries exactly one` };
  const d = found[0];
  if (d.kind === 'part' && !(d.n >= 1 && d.m >= 2 && d.n <= d.m)) return { error: `"part ${d.n} of ${d.m}" is not a part` };
  return d;
}

/** The issue a branch names (house rule 7: the branch starts with the issue id in lower case). */
export function branchKey(ref) {
  const m = new RegExp(`^${KEY}(?:-|$)`, 'i').exec(String(ref ?? ''));
  return m ? m[1].toUpperCase() : null;
}

// The ship routes (Wright 10-14 18:24 and his review ruling, from TRACKING and SHIPPING § 4–5): office, site and town
// ride the weekly train; world ships at a blessed settlement; the docs and ops repos are live on merge. A merge into
// an office, site or town main is a hotfix: Hotfixed is set at its tag by whoever cuts it, never at merge, so the state
// holds with a note. A site PR into main touching only the live-on-merge paths is live on merge: Shipped.
// world-spire (a private fork) has no route: a hand sets it.
const TRAIN_REPOS = new Set(['postmark-office', 'postmark-site', 'postmark']);
const LIVE_ON_MERGE = new Set(['postmark-blueprints', 'postmark-telemetry']);
/** A PR's changed paths from GitHub's files API: a renamed file counts under both its names, so moving code into a
 *  live-on-merge path is not read as live-only (review-handler leftover #1). */
export function pathsOf(apiFiles) {
  return apiFiles.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
}

/** postmark-site's paths that go live on merge to main, no tag (SHIPPING § 4). */
export const SITE_LIVE_PATHS = ['tools/', 'public/atelier/postmark/', 'src/data/postmark/', 'public/renditions/'];

/** The issue a PR is about: its done line's, else its branch's; null when neither names one of ours. */
export function issueKeyOf(pr) {
  const d = doneLine(pr.body);
  return d.error ? branchKey(pr.headRef) : d.key;
}

/**
 * Where a merge that finishes its issue goes, by repo, base and (for a site PR into main) its changed files:
 * { to } a state, or { to: null, why } with why one of 'hotfix', 'files-unread', 'unrouted'.
 * files is the PR's changed paths, or null when they could not be read.
 */
export function routeOf(repo, base, files = null) {
  const name = String(repo).replace(/^postmark-town\//, '');
  const train = /^train\//.test(String(base)), main = base === 'main' || base === 'master';
  if (TRAIN_REPOS.has(name) && train) return { to: 'On the Train' };
  if (name === 'postmark-site' && main) {
    if (!Array.isArray(files)) return { to: null, why: 'files-unread' };
    if (files.length && files.every((f) => SITE_LIVE_PATHS.some((p) => String(f).startsWith(p)))) return { to: 'Shipped' };
    return { to: null, why: 'hotfix' };
  }
  if (TRAIN_REPOS.has(name) && main) return { to: null, why: 'hotfix' };
  if (name === 'postmark-world' && main) return { to: 'Awaiting Settlement' };
  if (LIVE_ON_MERGE.has(name) && main) return { to: 'Shipped' };
  return { to: null, why: 'unrouted' };
}

// Our authors, and whose court a lane of theirs is in (Wright, 10-14 18:24: the pod Apps' bots, wright-starforge
// and keeminlee; in-session Plumb pushes as wright-starforge; a lane of Jetto's pushes as his App, and its Unsure is his). Anyone else's PR never touches Linear, not even a note,
// and a merge counts only when one of them merged it (review-handler #2).
export const AUTHORS = { 'rivet-starforge[bot]': 'rivet', 'bevel-starforge[bot]': 'bevel', 'jetto-starforge[bot]': 'jetto', 'facet-starforge[bot]': 'facet', 'wright-starforge': 'wright', keeminlee: 'wright' };
/** The rung a PR's author answers to, or null for an author who is not ours (gh prints an App as app/<slug>). */
export function rungOf(login) {
  const l = String(login ?? '').replace(/^app\/(.+)$/, '$1[bot]');
  return AUTHORS[l] ?? null;
}

const label = (pr) => `${String(pr.repo).replace(/^postmark-town\//, '')}#${pr.number}`;
// a state the handler doesn't know (a renamed state, a curly apostrophe) is never moved out of (review-handler #4)
const forward = (from, to) => Object.hasOwn(RANK, from) && (RANK[to] ?? -1) > RANK[from];
// a merge's "closes" moves an issue only from the states a lane is in (review-handler #2)
const LANE_STATES = new Set(['Building', 'In Review']);
// done-type states (TRACKING § The states: Shipped is a kind of Done, Hotfixed is Done by hotfix): the handler never
// moves an issue out of one (STAR-203)
export const DONE_STATES = new Set(['Hotfixed', 'Shipped', 'Done']);

/** The takes-main PR carries no issue by design (STAR-203, ruled 2026-11-18): its head branch starts `take-main/`, or its
 *  title is `train/<week> takes main at <sha>`. The check passes it and the handler moves nothing for it. */
export const takesMain = (pr) => /^take-main\//i.test(String(pr.headRef ?? '')) || /^train\/\S+ takes main at \S+$/i.test(String(pr.title ?? '').trim());

// The handler's own note for a merge into main that is a hotfix (office, site, town). It is also how a later train copy
// of the same issue knows a hotfix is already on main (STAR-203 rule 2), so the words live in one place.
const hotfixNote = (pr, key) => `${label(pr)} merged to ${pr.base} as a hotfix and closes ${key}; Hotfixed is set at its tag, by the handler (SHIPPING § 5). The state holds.`;
// Only for the repos with release tags (office, site), and only this repo's own note: a site hotfix note must not hold an
// office train PR (Truey, STAR-203). The note starts with `label(pr)`, so the match is anchored on `<repo>#<n>`.
const repoName = (repo) => String(repo).replace(/^postmark-town\//, '');
const hotfixOnMain = (issue, key, repo) => hasReleaseTags(repo)
  && (issue.handlerNotes ?? []).some((n) => new RegExp(`^${repoName(repo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#\\d+ merged to (?:main|master) as a hotfix and closes ${key};`).test(n));
// The town has no release tag: its main is live on merge (SHIPPING § 1), so a town hotfix is Hotfixed at the merge.
const isTown = (repo) => repoName(repo) === 'postmark';
/** The town's law files, which count as code (Wright, 2026-11-18 10:25 EST: SHIPPING § 1's town row lists "the law files" with
 *  code; that row is the canonical list): repo-root paths as the API's file list names them. Each exists in
 *  postmark-town/postmark at main (checked 2026-11-18); CONTRIBUTING*.md is a pattern. */
export const TOWN_LAW_FILES = new Set(['TOWN-RULES.md', 'STAMPS.md', 'MAIL.md', 'JOINING.md', 'PROMISES.md', 'ECONOMY-DIALS.json', 'quest-registry.json']);
/** Town code (SHIPPING § 1 town row: tools/, the ferry, the mint, the witness, the law files): anything under `tools/`, any
 *  .mjs/.js file, or a law file (TOWN_LAW_FILES, and the root CONTRIBUTING*.md rules). A PR touching none of these is docs. */
export const townCodePath = (f) => /^tools\//.test(String(f)) || /\.(?:mjs|js)$/.test(String(f)) || TOWN_LAW_FILES.has(String(f)) || /^CONTRIBUTING[^/]*\.md$/.test(String(f));
const isMainBase = (base) => base === 'main' || base === 'master';

export function decide({ event, pr, issue }) {
  const none = (check = { ok: true, summary: 'nothing for Linear' }) => ({ move: null, note: null, ladder: null, check });
  if (takesMain(pr)) return none({ ok: true, summary: 'a takes-main PR (a train takes main) carries no issue by design; Linear untouched' });
  const d = doneLine(pr.body);
  const bk = branchKey(pr.headRef);
  // the done line and the branch must name the same issue (house rule 7 names the branch with it; review-handler #2)
  const mismatch = !d.error && bk && bk !== d.key ? `the done line names ${d.key} but the branch names ${bk}` : null;
  const isReadyEvent = (event === 'opened' && !pr.draft) || event === 'ready_for_review' || (event === 'edited' && !pr.draft);
  // STAR-203 (TRACKING § A PR's done line): "a lane writes no `part N of M`"; a ready PR with one fails its check
  const partRefused = !d.error && d.kind === 'part' && isReadyEvent;
  const check = mismatch
    ? { ok: false, summary: `done line: ${mismatch}; fix one of them` }
    : partRefused
      ? { ok: false, summary: `done line: "part ${d.n} of ${d.m} · ${d.key}" is refused: one piece, one sub-issue, \`closes\` (TRACKING § A PR's done line). Fix: split it into a sub-issue and say \`closes <ID>\` (the sub-issue's id) on one line` }
    : d.error
      ? (isReadyEvent ? { ok: false, summary: `done line: ${d.error}. Add one line: "closes WLD-51" or "unsure · WLD-51" (an issue in several pieces gets a sub-issue per piece; a lane writes no "part N of M")` } : { ok: true, summary: `done line: ${d.error} (needed when the PR is ready)` })
      : { ok: true, summary: `done line: ${d.kind === 'part' ? `part ${d.n} of ${d.m}` : d.kind} · ${d.key}` };

  if (!rungOf(pr.author)) return none({ ok: true, summary: 'not one of our authors; Linear untouched' });
  const key = issueKeyOf(pr);
  if (!key) return none(check);
  if (!issue || issue.key !== key) return none({ ...check, summary: `${check.summary}; ${key} not found on Linear` });

  const merged = event === 'closed' && pr.merged;
  if (merged && !rungOf(pr.mergedBy)) return none({ ...check, summary: `${check.summary}; merged by someone not ours, so Linear is untouched` });
  const acts = event === 'opened' || event === 'ready_for_review' || event === 'converted_to_draft' || merged;
  if (!acts) return none(check);

  // one note per PR, whatever the event (review-handler #7): its words never depend on which event this is
  if (RED_ZONE.has(issue.state)) {
    // Gated is left by whoever put it there, or the lifter its Gate line names (STAR-172, Darko 2026-11-10; TRACKING § Gated); the rest of
    // the red zone only a hand leaves. Either way the handler moves nothing here.
    const leave = issue.state === 'Gated'
      ? `whoever put it into Gated, or the lifter its Gate line names, moves it out once the gate is met: linear-plan move ${key} "<state>", with the evidence`
      : 'red zone: only a hand moves it out';
    return { move: null, ladder: null, check, note: `${label(pr)} names ${key}; it stays in ${issue.state} (${leave}).` };
  }
  if (mismatch) {
    return { move: null, ladder: null, check, note: `${label(pr)}: ${mismatch}, so nothing moved; fix one of them.` };
  }

  // the lead's FIX (canon rule 7): its worker turns the PR back to draft, and the issue goes back to Building; the one
  // move backwards the handler makes on its own, and only from In Review
  if (event === 'converted_to_draft') {
    return { move: issue.state === 'In Review' ? 'Building' : null, note: null, ladder: null, check };
  }
  if (!merged) {
    if (pr.draft) return { move: forward(issue.state, 'Building') ? 'Building' : null, note: null, ladder: null, check };
    // A READY PR MOVES ITS ISSUE TO IN REVIEW ONLY WHEN IT FINISHES IT (Darko 2026-10-21 11:34, on Wright's rule): a
    // `closes` line or the last part (part M of M), the same reading a merge makes. An earlier part, an unsure or no
    // done line leaves the state where it is: an umbrella issue's other lanes are still building (world#266 opened
    // `unsure · WLD-25` and moved WLD-25 to In Review with four lanes on it).
    const finishes = !d.error && (d.kind === 'closes' || (d.kind === 'part' && d.n === d.m));
    if (finishes) return { move: forward(issue.state, 'In Review') ? 'In Review' : null, note: null, ladder: null, check };
    // A ready PR that doesn't finish its issue still means a lane has started, so from Queued it takes the issue to
    // Building, as a draft would. world#295 opened ready as part 1 of 3 and left WLD-97 in Queued, where no seat may move
    // it (Bevel's FAULT, 2026-11-13). Only from Queued (Wright, 16:05 EST: "Ready means nobody has picked the issue, and
    // picking is Darko's", TRACKING § Queued); never to In Review, never backwards.
    return { move: issue.state === 'Queued' ? 'Building' : null, note: null, ladder: null, check };
  }

  // a merge: the done line decides; a missing one is an unsure (the handler never guesses "done")
  const kind = d.error ? 'unsure' : d.kind === 'part' && d.n === d.m ? 'closes' : d.kind;
  if (kind === 'part') {
    // more PRs coming: the issue is (back) in Building, but only from a lane's states (leftover #3: never from
    // Backlog or Ready, which no lane had started)
    return { move: issue.state === 'Queued' || issue.state === 'In Review' ? 'Building' : null, note: null, ladder: null, check };
  }
  if (kind === 'unsure') {
    return { move: null, ladder: rungOf(pr.author), check, note: `Unsure (${label(pr)} merged): does it finish ${key}? ${d.error ? `The PR had ${d.error}. ` : ''}Asking up the ladder; the state holds until someone is sure.` };
  }
  if (DONE_STATES.has(issue.state)) {
    // a done state is never moved back (STAR-203): a hotfix's train copy merging after its tag lands here, and there is nothing to set by hand
    return { move: null, ladder: null, check, note: `${label(pr)} merged into ${pr.base} and closes ${key}, but ${key} is already ${issue.state}; the handler never moves a done state back, so it stays (a train copy of a hotfix lands here).` };
  }
  if (!LANE_STATES.has(issue.state)) {
    return { move: null, ladder: null, check, note: `${label(pr)} merged and closes ${key}, but ${key} is in ${issue.state}, not Building or In Review, so the merge moved nothing; set it by hand.` };
  }
  // the town's hotfix (a `closes` PR into main from a branch that isn't the train) is live on merge: Hotfixed now (STAR-203)
  // and the state follows what merged (ruled 2026-11-18): code is Hotfixed, a docs-only PR is Shipped (TRACKING: a
  // live-on-merge docs PR is Shipped); files the handler couldn't read are a hand's
  if (isTown(pr.repo) && isMainBase(pr.base) && !/^train\//.test(String(pr.headRef))) {
    if (!Array.isArray(pr.files) || !pr.files.length) {
      return { move: null, ladder: null, check, note: `${label(pr)} merged to ${pr.base} and closes ${key}, but its changed files could not be read, so whether it is town code (Hotfixed) or docs (Shipped) is unknown; set the state by hand.` };
    }
    if (pr.files.some(townCodePath)) {
      return { move: forward(issue.state, 'Hotfixed') ? 'Hotfixed' : null, note: `${label(pr)} merged to ${pr.base} as a hotfix and closes ${key}: live on merge (the town has no release tag), so ${key} is Hotfixed.`, ladder: null, check };
    }
    return { move: forward(issue.state, 'Shipped') ? 'Shipped' : null, note: `${label(pr)} merged to ${pr.base} and closes ${key}: live on merge (docs; TRACKING: a live-on-merge docs PR is Shipped), so ${key} is Shipped.`, ladder: null, check };
  }
  const r = routeOf(pr.repo, pr.base, pr.files ?? null);
  // a train copy of a hotfix that is already on main (STAR-203 rule 2): the issue waits for its tag, it doesn't ride the train
  if (r.to === 'On the Train' && hotfixOnMain(issue, key, pr.repo)) {
    return { move: null, ladder: null, check, note: `${label(pr)} merged into ${pr.base} and closes ${key}: a train copy of a hotfix that's on main; Hotfixed comes at the tag. ${key} stays in ${issue.state}.` };
  }
  if (r.to) return { move: forward(issue.state, r.to) ? r.to : null, note: null, ladder: null, check };
  const why = {
    hotfix: hotfixNote(pr, key),
    'files-unread': `${label(pr)} merged to ${pr.base} and closes ${key}, but its changed files could not be read, so whether it is live on merge is unknown; set the state by hand.`,
    unrouted: `${label(pr)} merged into ${pr.base} and closes ${key}, but no route is ruled for that repo and base; set the state by hand.`,
  }[r.why];
  return { move: null, ladder: null, check, note: why };
}

// ── Hotfixed at the tag (STAR-203; ruled 2026-11-18 for Darko's STAR-197 go) ──
// A hand-pushed `release/*` tag fires the caller's `on: push: tags` trigger. The handler lists the PRs merged into main
// between the previous release tag and this one (the commit subjects name them), and moves each one's issue to Hotfixed.

/** Release tags are cut for the repos that deploy from a tag: office and site (SHIPPING § 5). The town has none (its main is
 *  live on merge), and Hotfixed is set at the merge there. */
export const hasReleaseTags = (repo) => ['postmark-office', 'postmark-site'].includes(repoName(repo));

/** The release tag a push event made ("release/2026-w47.18"), or null: not a release tag, a deletion, or a PR event. */
export function tagOf(ev) {
  if (ev?.pull_request || ev?.deleted || typeof ev?.ref !== 'string' || !ev.ref.startsWith('refs/tags/release/')) return null;
  return ev.ref.slice('refs/tags/'.length);
}

// release/2026-wNN or release/2026-wNN.k: the week, then the patch number (a bare week sorts before .1)
const tagKey = (t) => { const m = /^release\/(\d{4})-w(\d{1,2})(?:\.(\d+))?$/.exec(String(t)); return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null; };
const tagLess = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
/** The newest release tag before `tag` in names (week, then patch), or null. Names that aren't release tags are ignored. */
export function previousTag(tag, names) {
  const me = tagKey(tag);
  if (!me) return null;
  let best = null, bestKey = null;
  for (const n of new Set(names)) {
    const k = tagKey(n);
    if (k && tagLess(k, me) && (!bestKey || tagLess(bestKey, k))) { best = n; bestKey = k; }
  }
  return best;
}

/** The PR numbers a commit range names, once each, in order: a squash subject ends "(#N)", a merge commit's starts
 *  "Merge pull request #N". commits are GitHub's compare entries ({ commit: { message } }). */
export function prNumbersOf(commits) {
  const out = [];
  for (const c of commits) {
    const subject = String(c?.commit?.message ?? '').split(/\r?\n/)[0];
    const m = /^Merge pull request #(\d+)\b/.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
    if (m && !out.includes(Number(m[1]))) out.push(Number(m[1]));
  }
  return out;
}

/**
 * The issues a tag's PRs name: PRs that merged into main in a hotfix repo, by one of ours (author and merger), from a
 * branch that is not a train or a takes-main, and whose done line is `closes`, `unsure` or the last part. A missing done
 * line is never guessed. One intent per issue: { key, pr, kind } (kind 'closes', or 'unsure': a note only).
 */
export function tagIntents({ prs }) {
  const seen = new Map();
  for (const pr of prs) {
    if (!pr.merged || !isMainBase(pr.base) || !hasReleaseTags(pr.repo)) continue;
    if (/^train\//.test(String(pr.headRef)) || takesMain(pr)) continue;
    if (!rungOf(pr.author) || !rungOf(pr.mergedBy)) continue;
    const d = doneLine(pr.body);
    if (d.error || (d.kind === 'part' && d.n !== d.m)) continue;
    const bk = branchKey(pr.headRef);
    if (bk && bk !== d.key) continue;
    // a `closes` (or the last part) finishes the issue; an `unsure` doesn't say so, so the tag only notes it
    const kind = d.kind === 'unsure' ? 'unsure' : 'closes';
    const had = seen.get(d.key);
    if (!had || (had.kind === 'unsure' && kind === 'closes')) seen.set(d.key, { key: d.key, pr, kind });
  }
  return [...seen.values()];
}

// the states a hotfix waits in until its tag; anything else is a hand's (a note says so)
const HOTFIX_FROM = new Set(['Building', 'In Review', 'On the Train', 'Awaiting Settlement']);

/** What a live tag does to one issue its PR named: { move, note }. */
export function decideTag({ tag, pr, issue, kind = 'closes' }) {
  if (!issue) return { move: null, note: null };
  const key = issue.key, s = issue.state;
  if (DONE_STATES.has(s) || s === 'Canceled' || s === 'Duplicate') return { move: null, note: null };
  // an unsure says nothing about finishing (TRACKING: "unsure: no move"): a note only, whatever the state
  if (kind === 'unsure') return { move: null, note: `${tag} is live and contains ${label(pr)}, an unsure hotfix for ${key} (it did not say it finishes it): ${key} stays in ${s}; Hotfixed if it finishes it.` };
  const what = `${tag} is live and contains ${label(pr)}, a hotfix that closes ${key}`;
  if (RED_ZONE.has(s)) return { move: null, note: `${what}, but ${key} stays in ${s} (red zone: only a hand moves it out). Hotfixed is what it should read.` };
  if (HOTFIX_FROM.has(s)) return { move: 'Hotfixed', note: `${what}: ${key} is Hotfixed.` };
  return { move: null, note: `${what}, but ${key} is in ${s}, not Building, In Review, On the Train or Awaiting Settlement, so nothing moved; set it by hand.` };
}
