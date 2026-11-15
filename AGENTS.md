# Working on Threshold

A single-user MCP server for Garmin data on Cloudflare Workers. Read README.md first.

## Commands

- `npm ci` — install
- `npm run typecheck` — TypeScript, no emit
- `npm test` — Vitest inside the Workers runtime (`@cloudflare/vitest-plugin`), against a fake Garmin API
- `npm run check` — typecheck, tests, dry-run build; run before every commit
- `npm run dev` — local server; needs `.dev.vars` (copy `.dev.vars.example`)
- `npm run gen:fit-profile` — regenerate `src/fit/profile.ts` after upgrading `@garmin/fitsdk`

## Rules

- Stay inside the Workers Free limits: 10 ms CPU and 50 external requests per invocation. Count Garmin calls
  through `Budget`; keep heavy work (FIT decoding) in the cron job or behind explicit tool calls.
- Code computes numbers; tools return them with units in the field names. Missing data is `null`, never `0`.
- Never return GPS coordinates, place names or personal identifiers unless the caller asks (`compact()`).
- Never log or return the Garmin key, the access key, or the Garmin bearer token.
- The schema is created at runtime (`src/archive/schema.ts`). Never edit a shipped migration; append a new one.
  Migration 1 builds its tables from `DAILY_COLUMNS` and `ACTIVITY_COLUMNS_V1` in `flatten.ts`, so those lists are
  frozen too: a new column goes into `ACTIVITY_COLUMNS_ADDED` and an `ALTER TABLE` in a new migration.
- When the FIT analysis archives something new or changes what it archives, raise `FIT_ANALYSIS_VERSION` in
  `src/archive/sync.ts`. Files decoded by an older version are then analyzed again in the background.
- Steady-effort metrics (decoupling, efficiency) are computed only for steady session types (`STEADY_TYPES`).
  Do not report them for interval sessions.
- The model never estimates a number the server could compute. A question about the future or about cause gets a
  tool (`race_predictor`, `load_forecast`, `correlate`), not a prompt that asks the model to work it out.
- Garmin payload shapes are not fully documented. Extract fields defensively (`num()`, `text()` in `flatten.ts`) and
  add the new shape to `test/helpers/mock-garmin.ts` with a test.
- Single user only: Garmin's Personal API terms forbid serving other people's data.
