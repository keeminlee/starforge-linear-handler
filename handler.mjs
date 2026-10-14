#!/usr/bin/env node
// handler.mjs: runs the canon's § B handler on one GitHub pull_request_target event. The reusable workflow calls it
// with the event file; it never checks out or runs the PR's code, and it reads the PR body only as data.
//
//   node handler.mjs <event.json>            act on Linear (the handler's own Linear app, client credentials)
//   HANDLER_DRY=1 node handler.mjs <event>   say what it would do, change nothing
//
// Env: LINEAR_APP, the handler's Linear app as two lines, client id then secret (postmark-town's org secret
// LINEAR_HANDLER_APP, passed in by each caller; never printed). GITHUB_STEP_SUMMARY when present.
// Exit: 0 done (or nothing to do), 1 the PR's done line check failed (a ready PR without one), 2 a failure to act.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decide, issueKeyOf, rungOf } from './handler-core.mjs';

const CONFIG = JSON.parse(readFileSync(new URL('./handler-config.json', import.meta.url), 'utf8'));

/** The core's view of a GitHub pull_request(_target) event. A PR from a fork is never ours, whoever wrote it. */
export function prOf(ev) {
  const p = ev.pull_request ?? {};
  const repo = ev.repository?.full_name ?? '';
  const fromFork = (p.head?.repo?.full_name ?? repo) !== repo;
  return {
    repo, number: p.number, base: p.base?.ref, headRef: p.head?.ref, draft: !!p.draft, merged: !!p.merged,
    body: p.body ?? '', author: fromFork ? null : p.user?.login,
  };
}

/** One event, end to end, against a Linear client (the real one, or a stub in the tests). */
export async function handle(ev, linear, { dry = false, log = () => {} } = {}) {
  const pr = prOf(ev);
  const event = ev.action;
  // the core needs the issue as Linear has it now; Linear is read only for our authors' PRs that name one
  const key = rungOf(pr.author) ? issueKeyOf(pr) : null;
  const issue = key ? await linear.issue(key) : null;
  const r = decide({ event, pr, issue });
  const did = [];
  if (issue && r.move) {
    const stateId = await linear.stateId(issue.teamId, r.move);
    if (!stateId) throw new Error(`team of ${issue.key} has no state "${r.move}"`);
    if (!dry) await linear.setState(issue.id, stateId);
    did.push(`${issue.key}: ${issue.state} → ${r.move}`);
  }
  if (issue && r.note) {
    // one note per fact: a re-run or a redelivered event never posts it twice
    if ((issue.handlerNotes ?? []).includes(r.note)) did.push(`${issue.key}: note already there`);
    else { if (!dry) await linear.comment(issue.id, r.note); did.push(`${issue.key}: note "${r.note}"`); }
  }
  if (issue && r.ladder) {
    const to = CONFIG.delegates?.[r.ladder];
    if (!to) did.push(`${issue.key}: unsure climbs to ${r.ladder}, but no Linear user is configured for it; delegate by hand`);
    else if (issue.delegateId === to) did.push(`${issue.key}: already delegated to ${r.ladder}`);
    else { if (!dry) await linear.setDelegate(issue.id, to); did.push(`${issue.key}: delegated to ${r.ladder}`); }
  }
  for (const d of did) log(`${dry ? 'would: ' : ''}${d}`);
  return { ...r, did };
}

// ── the real Linear client (the handler's own app, client credentials) ──

async function linearClient(env) {
  const [clientId, clientSecret] = String(env.LINEAR_APP ?? '').split(/\r?\n/).map((s) => s.trim());
  if (!clientId || !clientSecret) throw new Error('no Linear app credentials (LINEAR_APP: two lines, client id then secret)');
  const t = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'read,write' }),
  });
  if (!t.ok) throw new Error(`Linear token: HTTP ${t.status}`);
  const token = (await t.json()).access_token;
  const gql = async (query, variables) => {
    const r = await fetch('https://api.linear.app/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }) });
    const j = await r.json();
    if (!r.ok || j.errors) throw new Error(`Linear: ${j.errors?.[0]?.message ?? `HTTP ${r.status}`}`);
    return j.data;
  };
  const viewer = (await gql('query{ viewer{ id } }')).viewer.id;
  const states = {};
  return {
    async issue(key) {
      const d = await gql('query($id:String!){ issue(id:$id){ id identifier team{ id } state{ name } delegate{ id } comments(first:50){ nodes{ body user{ id } } } } }', { id: key });
      const i = d.issue;
      if (!i) return null;
      return { id: i.id, key: i.identifier, teamId: i.team.id, state: i.state.name, delegateId: i.delegate?.id ?? null,
        handlerNotes: i.comments.nodes.filter((c) => c.user?.id === viewer).map((c) => c.body) };
    },
    async stateId(teamId, name) {
      states[teamId] ??= Object.fromEntries((await gql('query($t:String!){ team(id:$t){ states{ nodes{ id name } } } }', { t: teamId })).team.states.nodes.map((s) => [s.name, s.id]));
      return states[teamId][name] ?? null;
    },
    setState: (id, stateId) => gql('mutation($id:String!,$s:String!){ issueUpdate(id:$id, input:{ stateId:$s }){ success } }', { id, s: stateId }),
    setDelegate: (id, userId) => gql('mutation($id:String!,$u:String!){ issueUpdate(id:$id, input:{ delegateId:$u }){ success } }', { id, u: userId }),
    comment: (issueId, body) => gql('mutation($i:CommentCreateInput!){ commentCreate(input:$i){ success } }', { i: { issueId, body } }),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const main = async () => {
    const ev = JSON.parse(readFileSync(process.argv[2] ?? process.env.GITHUB_EVENT_PATH, 'utf8'));
    const dry = process.env.HANDLER_DRY === '1';
    const lines = [];
    const log = (s) => { lines.push(s); console.log(s); };
    let r;
    try {
      const linear = dry && !process.env.LINEAR_APP ? stubFromNothing() : await linearClient(process.env);
      r = await handle(ev, linear, { dry, log });
    } catch (e) { console.error(`handler: ${e.message}`); return 2; }
    console.log(r.check.summary);
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, [`**${r.check.ok ? 'ok' : 'needs a done line'}**: ${r.check.summary}`, ...lines.map((l) => `- ${l}`)].join('\n') + '\n', { flag: 'a' });
    return r.check.ok ? 0 : 1;
  };
  // a dry run with no credentials reads nothing from Linear: the issue reads as not found
  function stubFromNothing() { return { issue: async () => null, stateId: async () => null }; }
  main().then((c) => { process.exitCode = c; });
}
