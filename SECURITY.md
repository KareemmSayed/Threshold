# Security

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/KareemmSayed/Threshold/security/advisories/new).
Do not open a public issue. You will get an answer within a few days.

## Design

Threshold is a single-user server that each person deploys to their own Cloudflare account.

* **Secrets.** The Garmin API key and the access key live in Worker secrets. The Garmin key is exchanged for a
  24-hour bearer token, which is cached in the owner's KV namespace. Neither key is logged or returned by any tool.
* **Access.** `/mcp` accepts an OAuth access token issued by this server (audience-bound to its `/mcp` URL) or
  `Authorization: Bearer <ACCESS_KEY>`. The access key is compared in constant time. OAuth uses PKCE (S256),
  dynamic client registration and Client ID Metadata Documents through
  [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider); tokens and grants
  are stored hashed and encrypted in KV.
* **Consent.** Approving an app requires the access key. The consent page shows the redirect host, warns about
  loopback redirects, cannot be framed, and binds the form to the browser that opened it.
* **Read-only.** The Garmin Personal API is read-only. The SQL tool accepts a single `SELECT`/`WITH` statement,
  rejects write and schema keywords outside string literals, blocks internal tables and server state, and caps rows.
* **Data minimisation.** Tool output drops GPS coordinates, place names and personal identifiers unless the caller
  asks for location data explicitly.

## Choosing an access key

Use at least 20 random characters; let a password manager generate them, or copy the suggestion your server's page shows while the key is missing. Anyone with the access key can read your
Garmin data through your server. To rotate it, run `npx wrangler secret put ACCESS_KEY`. Every OAuth token issued
before the rotation stops working at once, and connected apps must sign in again.
