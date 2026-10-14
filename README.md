# starforge-handler

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
(the handler's own Linear app, client credentials from the org secrets `LINEAR_HANDLER_CLIENT_ID` / `_SECRET`).
`HANDLER_DRY=1 node handler.mjs <event.json>` says what it would do and changes nothing.
