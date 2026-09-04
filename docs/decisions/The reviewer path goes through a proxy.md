---
title: The reviewer path goes through a proxy
tags: [decision]
---
# The reviewer path goes through a proxy

A reviewer runs the CLI with only their own `OPENAI_API_KEY`. The project's public OAuth client id and the
URL of a small Cloudflare Worker are defaults in `src/gmail/auth.ts`; when `.env` has no
`GOOGLE_CLIENT_SECRET`, the authorization-code exchange and every refresh `POST` JSON to `<proxy>/token`
(`{grant_type: "authorization_code", code, code_verifier, redirect_uri}` or
`{grant_type: "refresh_token", refresh_token}`). The Worker adds the client id and secret, forwards the
form-encoded request to Google, and returns Google's status and JSON unchanged, so the CLI's error handling
reads the same document either way. The token file stores `client_secret: ""` and a `token_proxy` so later
commands refresh through the same place.

**Why.** A desktop OAuth client's secret is not truly secret (PKCE is the real protection), but handing it
out in a `.env` is still worse than a proxy that only ever exchanges codes for this one client id: the proxy
accepts two grant shapes, drops every other field, caps the body, and cannot be pointed at another client.
It also removes the one setup step that was not the reviewer's own key.

**What stays.** Setting `GOOGLE_CLIENT_SECRET` switches to the direct exchange with Google, byte for byte
what it was; an explicitly empty `ROZE_TOKEN_PROXY` with no secret is a clear error. The Worker lives
outside this repository (no new dependency here) and holds the secret as a Worker secret, never in a file.
The loopback sign-in, PKCE, the owner-only token file, and the renewing token source are unchanged; see
[[Lightweight, no frameworks]].

Since 2026-09-04 the same Worker also forwards Responses API calls on a separate OpenAI key with a $5
hard budget when `OPENAI_API_KEY` is unset (`POST /openai/v1/responses`, marker header `x-roze-client`).
The marker is not a secret; the key's budget is the guard, and the key is revoked after review.
