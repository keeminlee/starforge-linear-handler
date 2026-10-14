# starforge-linear-handler

The one thing that moves Postmark's Linear issue states automatically (the lifecycle canon, § B, in
postmark-telemetry `docs/canon/`). Every PR event in postmark-town's repos runs it through a ~10-line caller
(`caller/linear-handler.yml`, copied into each repo's `.github/workflows/`), which calls the reusable workflow here.

- **The red zone** (Gated, Needs a Sitting, Darko's Call) is left only by a hand. A PR event there moves nothing and
  leaves one note.
- **The done line** is one required line in the PR body: `closes WLD-51`, `part 1 of 2 · WLD-51` or
  `unsure · WLD-51`. A ready PR without one fails this check.
- **The moves:** a draft PR opens to Building, and a ready PR to In Review. A merge goes by its done line: closes is
  routed by repo and base; a part stays Building; unsure (or no line) holds the state, leaves a note, and delegates
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
