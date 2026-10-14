// handler-core.mjs: the one automatic mover of Linear states (the lifecycle canon, § B; Darko's 10-14 sitting).
// Pure: it takes a PR event and the linked issue as it reads now, and says what to do. The workflow around it
// reads GitHub's event and Linear, then acts on the answer. Every arrow of canon § B is a test in handler-core.test.mjs.
//
//   decide({ event, pr, issue }) -> { move, note, ladder, check }   (pr.author is the PR's GitHub login)
//     move    the state to set, or null
//     note    one comment for the issue, or null (only for a red-zone refusal, an unsure, or a route nobody ruled)
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
  for (const raw of String(body ?? '').split(/\r?\n/)) {
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

// The ship routes (Wright, 10-14 18:24, from SHIPPING): office, site and town ride the weekly train, and a PR into
// their main is a hotfix (Hotfixed at its tag); world ships at a blessed settlement; the docs and ops repos are live
// on merge. world-spire (a private fork) has no route: a hand sets it.
const TRAIN_REPOS = new Set(['postmark-office', 'postmark-site', 'postmark']);
const LIVE_ON_MERGE = new Set(['postmark-blueprints', 'postmark-telemetry']);

/** The issue a PR is about: its done line's, else its branch's; null when neither names one of ours. */
export function issueKeyOf(pr) {
  const d = doneLine(pr.body);
  return d.error ? branchKey(pr.headRef) : d.key;
}

/** The state a merge that finishes its issue goes to, by repo and base (canon § B "repo and base"); null when no route is ruled. */
export function routeOf(repo, base) {
  const name = String(repo).replace(/^postmark-town\//, '');
  const train = /^train\//.test(base), main = base === 'main' || base === 'master';
  if (TRAIN_REPOS.has(name) && train) return 'On the Train';
  if (TRAIN_REPOS.has(name) && main) return 'Hotfixed';
  if (name === 'postmark-world' && main) return 'Awaiting Settlement';
  if (LIVE_ON_MERGE.has(name) && main) return 'Shipped';
  return null;
}

// Our authors, and whose court a lane of theirs is in (Wright, 10-14 18:24: the pod Apps' bots, wright-starforge
// and keeminlee; in-session Plumb pushes as wright-starforge). Anyone else's PR never touches Linear, not even a note.
export const AUTHORS = { 'rivet-starforge[bot]': 'rivet', 'bevel-starforge[bot]': 'bevel', 'wright-starforge': 'wright', keeminlee: 'wright' };
/** The rung a PR's author answers to, or null for an author who is not ours (gh prints an App as app/<slug>). */
export function rungOf(login) {
  const l = String(login ?? '').replace(/^app\/(.+)$/, '$1[bot]');
  return AUTHORS[l] ?? null;
}

const label = (pr) => `${String(pr.repo).replace(/^postmark-town\//, '')}#${pr.number}`;
const forward = (from, to) => (RANK[to] ?? -1) > (RANK[from] ?? -1);

export function decide({ event, pr, issue }) {
  const none = (check = { ok: true, summary: 'nothing for Linear' }) => ({ move: null, note: null, ladder: null, check });
  const d = doneLine(pr.body);
  const isReadyEvent = (event === 'opened' && !pr.draft) || event === 'ready_for_review' || (event === 'edited' && !pr.draft);
  const check = d.error
    ? (isReadyEvent ? { ok: false, summary: `done line: ${d.error}. Add one line: "closes WLD-51", "part 1 of 2 · WLD-51" or "unsure · WLD-51"` } : { ok: true, summary: `done line: ${d.error} (needed when the PR is ready)` })
    : { ok: true, summary: `done line: ${d.kind === 'part' ? `part ${d.n} of ${d.m}` : d.kind} · ${d.key}` };

  if (!rungOf(pr.author)) return none({ ok: true, summary: 'not one of our authors; Linear untouched' });
  const key = issueKeyOf(pr);
  if (!key) return none(check);
  if (!issue || issue.key !== key) return none({ ...check, summary: `${check.summary}; ${key} not found on Linear` });

  const merged = event === 'closed' && pr.merged;
  const acts = event === 'opened' || event === 'ready_for_review' || event === 'converted_to_draft' || merged;
  if (!acts) return none(check);

  if (RED_ZONE.has(issue.state)) {
    return { move: null, ladder: null, check, note: `${label(pr)} ${merged ? 'merged' : event === 'opened' ? 'opened' : event === 'converted_to_draft' ? 'went back to draft' : 'is ready'}; ${key} stays in ${issue.state} (red zone: only a hand moves it out).` };
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
    return { move: issue.state === 'In Review' || forward(issue.state, 'Building') ? 'Building' : null, note: null, ladder: null, check };
  }
  if (kind === 'unsure') {
    return { move: null, ladder: rungOf(pr.author), check, note: `Unsure (${label(pr)} merged): does it finish ${key}? ${d.error ? `The PR had ${d.error}. ` : ''}Asking up the ladder; the state holds until someone is sure.` };
  }
  const to = routeOf(pr.repo, pr.base);
  if (!to) return { move: null, ladder: null, check, note: `${label(pr)} merged into ${pr.base} and closes ${key}, but no route is ruled for that repo and base; set the state by hand.` };
  return { move: forward(issue.state, to) ? to : null, note: null, ladder: null, check };
}
