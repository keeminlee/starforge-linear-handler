#!/usr/bin/env node
// handler.mjs: runs the canon's § B handler on one GitHub pull_request_target event. The reusable workflow calls it
// with the event file; it never checks out or runs the PR's code, and it reads the PR body only as data.
//
//   node handler.mjs <event.json>            act on Linear (the handler's own Linear app, client credentials)
//   HANDLER_DRY=1 node handler.mjs <event>   say what it would do, change nothing (the default until the cutover:
//                                            the caller passes live only when vars.LINEAR_HANDLER_LIVE is 1)
//
// Env: LINEAR_APP, the handler's Linear app as two lines, client id then secret (postmark-town's org secret
// LINEAR_HANDLER_APP, passed in by each caller; never printed). GITHUB_TOKEN to read a site PR's changed files.
// GITHUB_STEP_SUMMARY and GITHUB_OUTPUT when present.
// Exit: 0, with outputs check_ok and check_summary for the workflow's done-line step; 2 a failure to act (the
// "linear" step fails, which is what the sentinel's probe reads; review-handler #3).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decide, decideTag, hasReleaseTags, issueKeyOf, pathsOf, previousTag, prNumbersOf, rungOf, tagIntents, tagOf, takesMain } from './handler-core.mjs';

const CONFIG = JSON.parse(readFileSync(new URL('./handler-config.json', import.meta.url), 'utf8'));

/** The core's view of a GitHub pull_request(_target) event. A PR from a fork, or whose head repo is gone (a deleted
 *  fork), is never ours, whoever wrote it (review-handler #5). */
export function prOf(ev) {
  const p = ev.pull_request ?? {};
  const repo = ev.repository?.full_name ?? '';
  const ours = !!repo && p.head?.repo?.full_name === repo;
  return {
    repo, number: p.number, base: p.base?.ref, headRef: p.head?.ref, draft: !!p.draft, merged: !!p.merged,
    title: p.title ?? '', body: p.body ?? '', author: ours ? p.user?.login : null, mergedBy: p.merged_by?.login ?? null,
  };
}

/** Whether a merge needs its changed files read: a site PR into main, by our author, merged by one of ours. */
const needsFiles = (event, pr) => event === 'closed' && pr.merged && rungOf(pr.author) && rungOf(pr.mergedBy)
  && /(^|\/)postmark-site$/.test(pr.repo) && (pr.base === 'main' || pr.base === 'master');

/**
 * One event, end to end. deps.linear is a Linear client, or a function that makes one: it is made only when an
 * event by one of our authors names an issue, so a stranger's event never mints a token and a Linear failure never
 * touches a PR that isn't ours (review-handler #3). deps.files(repo, number) reads a PR's changed paths (null if
 * it can't).
 */
export async function handle(ev, deps, { dry = false, log = () => {} } = {}) {
  const pr = prOf(ev);
  const event = ev.action;
  if (needsFiles(event, pr)) pr.files = deps.files ? await deps.files(pr.repo, pr.number).catch(() => null) : null;
  const key = rungOf(pr.author) && !takesMain(pr) ? issueKeyOf(pr) : null;
  let linear = null;
  const client = async () => (linear ??= typeof deps.linear === 'function' ? await deps.linear() : deps.linear);
  const issue = key ? await (await client()).issue(key) : null;
  const r = decide({ event, pr, issue });
  const did = [];
  if (issue && r.move) {
    const stateId = await (await client()).stateId(issue.teamId, r.move);
    if (!stateId) throw new Error(`team of ${issue.key} has no state "${r.move}"`);
    if (!dry) await (await client()).setState(issue.id, stateId);
    did.push(`${issue.key}: ${issue.state} → ${r.move}`);
  }
  if (issue && r.note) {
    // one note per fact: a re-run or a redelivered event never posts it twice
    if ((issue.handlerNotes ?? []).includes(r.note)) did.push(`${issue.key}: note already there`);
    else { if (!dry) await (await client()).comment(issue.id, r.note); did.push(`${issue.key}: note "${r.note}"`); }
  }
  if (issue && r.ladder) {
    const to = CONFIG.delegates?.[r.ladder];
    if (!to) did.push(`${issue.key}: unsure climbs to ${r.ladder}, but no Linear user is configured for it; delegate by hand`);
    else if (issue.delegateId === to) did.push(`${issue.key}: already delegated to ${r.ladder}`);
    else { if (!dry) await (await client()).setDelegate(issue.id, to); did.push(`${issue.key}: delegated to ${r.ladder}`); }
  }
  for (const d of did) log(`${dry ? 'would: ' : ''}${d}`);
  return { ...r, did };
}

/** The PRs a release tag contains, from a GitHub reader (api(path) -> parsed JSON): the commits between the previous
 *  release tag and this one name them (PR numbers in their subjects), and each is read whole. { prs } or { prs: [], why }
 *  when the range can't be read as a hotfix's: no previous tag, or one that is a ship's size (a ship tag has no hotfix
 *  issue to set here, and a hand reads it). */
export async function tagPrsWith(api, repo, tag, { maxCommits = 250, maxPrs = 100 } = {}) {
  // matching-refs returns every match in one answer and ignores per_page and page (Truey's live read: the same 168 refs on
  // every page), so it is read once
  const names = (await api(`/repos/${repo}/git/matching-refs/tags/release/`)).map((r) => String(r.ref).replace(/^refs\/tags\//, ''));
  const prev = previousTag(tag, names);
  if (!prev) return { prs: [], why: `no previous release tag before ${tag}, so there is no range to read` };
  const cmp = await api(`/repos/${repo}/compare/${encodeURIComponent(prev)}...${encodeURIComponent(tag)}`);
  if (cmp.ahead_by > cmp.commits.length || cmp.commits.length >= maxCommits) return { prs: [], why: `${prev}...${tag} is ${cmp.ahead_by} commits, too many to read as a hotfix; a hand reads it` };
  const numbers = prNumbersOf(cmp.commits);
  if (numbers.length > maxPrs) return { prs: [], why: `${prev}...${tag} names ${numbers.length} PRs, too many to read as a hotfix; a hand reads it` };
  const prs = [], skipped = [];
  for (const n of numbers) {
    let p;
    try { p = await api(`/repos/${repo}/pulls/${n}`); }
    // a "(#N)" in a subject that is not a PR of this repo (an issue number, a reference) is skipped, never a failure
    catch (e) { if (e.status === 404) { skipped.push(`#${n} is named in a commit subject but is not a PR of ${repo} (404); skipped`); continue; } throw e; }
    prs.push(prOf({ action: 'closed', repository: { full_name: repo }, pull_request: p }));
  }
  return { prs, prev, skipped };
}

/**
 * A release tag pushed by hand (the caller's `on: push: tags: release/*`): every issue its hotfix PRs closed goes to
 * Hotfixed, with a note naming the tag (STAR-203). deps.linear as in handle; deps.tagPrs(repo, tag) -> { prs, why? }.
 * One failure (a team without the state) doesn't stop the others: it is thrown after the rest are done, so the
 * "linear" step still fails and says so.
 */
export async function handleTag(ev, deps, { dry = false, log = () => {} } = {}) {
  const tag = tagOf(ev), repo = ev.repository?.full_name ?? '';
  const check = (summary) => ({ ok: true, summary });
  if (!tag) return { did: [], check: check('not a release tag push; nothing for Linear') };
  if (!hasReleaseTags(repo)) return { did: [], check: check(`${tag}: ${repo} has no release tags to read (the town's hotfix is Hotfixed at its merge); nothing for Linear`) };
  const { prs, why, skipped = [] } = await deps.tagPrs(repo, tag);
  for (const s of skipped) log(s);
  if (why) { log(why); return { did: [], check: check(`${tag}: ${why}`) }; }
  const intents = tagIntents({ tag, prs });
  let linear = null;
  const client = async () => (linear ??= typeof deps.linear === 'function' ? await deps.linear() : deps.linear);
  const did = [], failed = [];
  for (const { key, pr, kind } of intents) {
    try {
      const issue = await (await client()).issue(key);
      const r = decideTag({ tag, pr, issue, kind });
      if (issue && r.move) {
        const stateId = await (await client()).stateId(issue.teamId, r.move);
        if (!stateId) throw new Error(`team of ${issue.key} has no state "${r.move}"`);
        if (!dry) await (await client()).setState(issue.id, stateId);
        did.push(`${issue.key}: ${issue.state} → ${r.move}`);
      }
      if (issue && r.note) {
        if ((issue.handlerNotes ?? []).includes(r.note)) did.push(`${issue.key}: note already there`);
        else { if (!dry) await (await client()).comment(issue.id, r.note); did.push(`${issue.key}: note "${r.note}"`); }
      }
    } catch (e) { failed.push(`${key}: ${e.message}`); }
  }
  for (const d of did) log(`${dry ? 'would: ' : ''}${d}`);
  if (failed.length) throw new Error(failed.join('; '));
  return { did, check: check(`${tag}: ${intents.length} hotfix issue(s) read, ${did.length} act(s)${skipped.length ? `; ${skipped.length} skipped` : ''}`) };
}

// ── the real clients ──

async function linearClient(env) {
  const [clientId, clientSecret] = String(env.LINEAR_APP ?? '').split(/\r?\n/).map((s) => s.trim());
  if (!clientId || !clientSecret) throw new Error('no Linear app credentials (LINEAR_APP: two lines, client id then secret)');
  const t = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'read,write' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!t.ok) throw new Error(`Linear token: HTTP ${t.status}`);
  const token = (await t.json()).access_token;
  const gql = async (query, variables) => {
    const r = await fetch('https://api.linear.app/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000) });
    const j = await r.json();
    if (!r.ok || j.errors) throw new Error(`Linear: ${j.errors?.[0]?.message ?? `HTTP ${r.status}`}`);
    return j.data;
  };
  const viewer = (await gql('query{ viewer{ id } }')).viewer.id;
  const states = {};
  return {
    async issue(key) {
      const d = await gql('query($id:String!){ issue(id:$id){ id identifier team{ id } state{ name } delegate{ id } comments(first:100){ nodes{ body user{ id } } } } }', { id: key });
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

/** One GitHub API read (the job's own token; a public repo needs no more). */
async function githubApi(path) {
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const headers = { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const r = await fetch(`${api}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw Object.assign(new Error(`GitHub ${path.split('?')[0]}: HTTP ${r.status}`), { status: r.status });
  return r.json();
}

/** A PR's changed paths, from the GitHub API (the job's own token; a public repo needs no more). Up to 3,000 files. */
async function prFiles(repo, number) {
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const headers = { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const r = await fetch(`${api}/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`GitHub files: HTTP ${r.status}`);
    const batch = await r.json();
    out.push(...pathsOf(batch));
    if (batch.length < 100) return out;
  }
  return null; // more than 3,000 files: unknown, so a hand decides
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const summary = (lines) => { if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' }); };
  const output = (k, v) => { if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `${k}=${String(v).replace(/[\r\n]+/g, ' ')}\n`, { flag: 'a' }); };
  const main = async () => {
    const ev = JSON.parse(readFileSync(process.argv[2] ?? process.env.GITHUB_EVENT_PATH, 'utf8'));
    const dry = process.env.HANDLER_DRY !== '0';
    const lines = [];
    const log = (s) => { lines.push(s); console.log(s); };
    let r;
    try {
      const linear = dry && !process.env.LINEAR_APP ? () => stubFromNothing() : () => linearClient(process.env);
      r = tagOf(ev) ? await handleTag(ev, { linear, tagPrs: (repo, tag) => tagPrsWith(githubApi, repo, tag) }, { dry, log })
        : await handle(ev, { linear, files: prFiles }, { dry, log });
    } catch (e) {
      console.error(`handler: ${e.message}`);
      summary([`**the handler failed to act** (${dry ? 'dry' : 'live'}): ${e.message}`, ...lines.map((l) => `- ${l}`)]);
      return 2;
    }
    console.log(r.check.summary);
    output('check_ok', r.check.ok);
    output('check_summary', r.check.summary);
    summary([`**${dry ? 'dry run' : 'live'}** · ${r.check.ok ? 'ok' : 'the done line needs fixing'}: ${r.check.summary}`, ...lines.map((l) => `- ${l}`)]);
    return 0;
  };
  // a dry run with no credentials reads nothing from Linear: the issue reads as not found
  function stubFromNothing() { return { issue: async () => null, stateId: async () => null }; }
  main().then((c) => { process.exitCode = c; });
}
