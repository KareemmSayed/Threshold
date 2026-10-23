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
- Garmin payload shapes are not fully documented. Extract fields defensively (`num()`, `text()` in `flatten.ts`) and
  add the new shape to `test/helpers/mock-garmin.ts` with a test.
- Single user only: Garmin's Personal API terms forbid serving other people's data.
