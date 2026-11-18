# starforge-linear-handler

The one thing that moves Postmark's Linear issue states automatically (the lifecycle canon, § B, in
postmark-telemetry `docs/canon/`). Every PR event in postmark-town's repos runs it through a ~10-line caller
(`caller/linear-handler.yml`, copied into each repo's `.github/workflows/`), which calls the reusable workflow here.

- **The red zone** (Gated, Needs a Sitting, Darko's Call): a PR event there moves nothing and leaves one note. Needs a
  Sitting and Darko's Call are left only by a hand; Gated is left by whoever put it there, or the lifter its Gate line names, once the gate is met
  (`linear-plan move`, with the evidence; STAR-152, Darko 2026-11-09), and its note says so.
- **The done line** is one required line in the PR body: `closes WLD-51` or `unsure · WLD-51`. A ready PR without one
  fails this check, and so does a ready PR with `part N of M · WLD-51`: one piece, one sub-issue, `closes` (TRACKING;
  STAR-203). Split it into a sub-issue and say `closes <ID>`.
- **The moves:** a draft PR opens to Building. A ready PR (opened or marked ready) moves its issue to In Review only
  when it finishes it: a `closes` line or the last part (`part M of M`); an earlier part, unsure or no line leaves the
  state where it is. A merge goes by its done line: closes is routed by repo and base; a part stays Building; unsure (or no line) holds the state, leaves a note, and delegates
  the issue to the lane's first rung.
- Only our own authors' PRs touch Linear: the pod Apps, wright-starforge and keeminlee. A fork's PR never does. The
  handler never checks out or runs PR code.

`handler-core.mjs` is pure, and every arrow is a test (`node --test`). `handler.mjs` adds GitHub's event and Linear
(the handler's own Linear app, client credentials from postmark-town's org secret `LINEAR_HANDLER_APP`, two lines,
passed into the reusable workflow as `LINEAR_APP`). A caller pins this repo by commit: replace both `HANDLER_SHA`s in
`caller/linear-handler.yml` with the reviewed commit.
`HANDLER_DRY=1 node handler.mjs <event.json>` says what it would do and changes nothing.

The handler's Linear app user is **handler meepling** (`134f09b4-b96c-4156-8f12-2c33a5d1ab48`), so its moves and notes read
as the handler's, never a hand's. Every run mints with the same scopes (`read,write`): Linear returns the live token for
the same scope set, and a mint with a different set would revoke the app's other tokens, so keep them the same.
`handler-config.json` holds the Linear user ids an Unsure is delegated to (the seats' own app users, and Wright's).

## Dry until the cutover, then one variable
Every caller passes `live: ${{ vars.LINEAR_HANDLER_LIVE == '1' }}`. With postmark-town's org variable unset, the handler
runs **dry**: it reads Linear and writes what it would do in the job summary, and it moves nothing. The cutover happens
in one sitting: Wright turns off Linear's four git automations, and sets `LINEAR_HANDLER_LIVE=1`. Rolling back means
unsetting it. Before it goes live, a dry repeat of a red-zone event must say "note already there" once a live note
exists.

## What fails, and what that means
The job has two steps. **`linear`** fails only when the handler could not act: Linear down, a bad secret, an unknown
state. That is the alarm, and the job summary says why. **`done line`** fails when the PR's done line needs fixing,
which is the PR author's to fix and never an alarm.

## The rules a merge must pass (review-handler, 10-14)
- The done line and the branch name the same issue.
- `closes` moves an issue only from Building or In Review.
- Our author opened the PR and one of ours merged it.
- A state the handler doesn't know is never moved out of.
- A merge into office, site or town `main` is a hotfix: a note, and Hotfixed is set at its tag by hand. The exception
  is a site PR that touches only the live-on-merge paths (SHIPPING § 4), which is Shipped at merge.

## Known behaviours
- **A merge through GitHub's merge queue** is merged by `github-merge-queue[bot]`, which is not one of ours, so Linear
  is untouched and the state is set by hand. None of our repos uses a merge queue today. If one starts to, add the
  queue's bot to `AUTHORS` deliberately.
- **A part merge** (`part N of M`, N < M) moves Queued or In Review back to Building. It never moves Backlog or Ready,
  which no lane had started. The check refuses a ready PR that carries one (above), so this is the old behaviour for a
  PR that got through anyway.
- **Hotfixed at the tag (STAR-203).** The caller's `on: push: tags: ["release/*"]` fires on a hand-pushed release tag
  (a tag pushed with `GITHUB_TOKEN`, the weekly ship's own, fires nothing). In office and site (the repos that cut
  release tags) the handler reads the commits between the previous release tag (by week, then patch number) and this
  one, finds the PRs they name, and sets each PR's issue to Hotfixed when the PR merged into `main` from a branch that
  is not `train/*` or `take-main/*`, by one of ours, with a `closes` or last-part done line. An `unsure` PR gets a note
  only. It moves from Building, In Review, On the Train or Awaiting Settlement, never from a done-type state or the
  red zone, and leaves one note naming the tag. A range with no previous tag, or ship-sized (250 commits, 100 PRs), is
  read by a hand; a `(#N)` that is not a PR here is skipped with a line in the job summary. **Limits:** Hotfixed is set
  at the tag push, even if the deploy then fails or a box step is pending (SHIPPING § 3: the issue shouldn't read
  Hotfixed until it's done); the previous tag is chosen by name, not by ancestry; a rebase merge carries no `#N` and is
  missed; a revert in the range still names the reverted PR.
- **The town has no release tag** (its `main` is live on merge, SHIPPING § 1): a `closes X` PR into the town's `main`
  from a branch that isn't `train/*` is live on merge, and the state follows what merged (the handler reads the PR's
  files): **town code** (anything under `tools/`, or any `.mjs`/`.js` file) sets X to Hotfixed; **docs only** sets it to
  Shipped (TRACKING: a live-on-merge docs PR is Shipped); files that can't be read are a note for a hand.
- **A train copy of a hotfix doesn't ride the train** (office and site). A `closes X` merge into `train/*` while this
  repo's own hotfix note for X is on the issue (a `closes X` PR already merged into `main`) moves nothing: X waits for
  its tag. A town train copy meets an already-Hotfixed issue and leaves it.
- **A takes-main PR carries no issue.** A head branch `take-main/*`, or a title `train/<week> takes main at <sha>`,
  passes the check with a note, and nothing moves.
- **A done state is never moved back** (Hotfixed, Shipped, Done; STAR-203). A hotfix's train copy merging after the tag
  leaves the issue where it is, with one note saying so.
- **An HTML comment is never a done line:** only a visible line counts.
- **A renamed file counts under both its names,** so code moved into a site live-on-merge path still reads as a hotfix.
