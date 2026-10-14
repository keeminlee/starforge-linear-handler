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

export const TEAMS = ['POS', 'WLD'];
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
  // an HTML comment is the template's explanation, never a done line (review-handler leftover #4)
  const visible = String(body ?? '').replace(/<!--[\s\S]*?-->/g, '');
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
// and keeminlee; in-session Plumb pushes as wright-starforge). Anyone else's PR never touches Linear, not even a note,
// and a merge counts only when one of them merged it (review-handler #2).
export const AUTHORS = { 'rivet-starforge[bot]': 'rivet', 'bevel-starforge[bot]': 'bevel', 'wright-starforge': 'wright', keeminlee: 'wright' };
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

export function decide({ event, pr, issue }) {
  const none = (check = { ok: true, summary: 'nothing for Linear' }) => ({ move: null, note: null, ladder: null, check });
  const d = doneLine(pr.body);
  const bk = branchKey(pr.headRef);
  // the done line and the branch must name the same issue (house rule 7 names the branch with it; review-handler #2)
  const mismatch = !d.error && bk && bk !== d.key ? `the done line names ${d.key} but the branch names ${bk}` : null;
  const isReadyEvent = (event === 'opened' && !pr.draft) || event === 'ready_for_review' || (event === 'edited' && !pr.draft);
  const check = mismatch
    ? { ok: false, summary: `done line: ${mismatch}; fix one of them` }
    : d.error
      ? (isReadyEvent ? { ok: false, summary: `done line: ${d.error}. Add one line: "closes WLD-51", "part 1 of 2 · WLD-51" or "unsure · WLD-51"` } : { ok: true, summary: `done line: ${d.error} (needed when the PR is ready)` })
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
    return { move: null, ladder: null, check, note: `${label(pr)} names ${key}; it stays in ${issue.state} (red zone: only a hand moves it out).` };
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
    const to = pr.draft ? 'Building' : 'In Review';
    return { move: forward(issue.state, to) ? to : null, note: null, ladder: null, check };
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
  if (!LANE_STATES.has(issue.state)) {
    return { move: null, ladder: null, check, note: `${label(pr)} merged and closes ${key}, but ${key} is in ${issue.state}, not Building or In Review, so the merge moved nothing; set it by hand.` };
  }
  const r = routeOf(pr.repo, pr.base, pr.files ?? null);
  if (r.to) return { move: forward(issue.state, r.to) ? r.to : null, note: null, ladder: null, check };
  const why = {
    hotfix: `${label(pr)} merged to ${pr.base} as a hotfix and closes ${key}; Hotfixed is set at its tag by whoever cuts it (SHIPPING § 5). The state holds.`,
    'files-unread': `${label(pr)} merged to ${pr.base} and closes ${key}, but its changed files could not be read, so whether it is live on merge is unknown; set the state by hand.`,
    unrouted: `${label(pr)} merged into ${pr.base} and closes ${key}, but no route is ruled for that repo and base; set the state by hand.`,
  }[r.why];
  return { move: null, ladder: null, check, note: why };
}
