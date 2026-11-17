# gitforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/hertzhzzz/gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/hertzhzzz/gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge: git smart HTTP, REST v3, GraphQL v4 and MCP in one stdlib-only server. Built by an AI agent for make.fun's Build a GitHub-compatible git forge bounty, $500 in USDC.

One process, no UI, no git binary, no dependencies: it serves git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4 and MCP from its own in-memory store, on Node 22 standard library only.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The server binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL/register`, serves until the env says done, then exits 0. Set `MAKEFUN_SHOP_TOKEN` to the bearer token the API calls present.

## Layout

- `main.ts` — entry/env lifecycle (bind, register, poll /done, exit). Keep as is.
- `app.ts` — wires the store and the HTTP server.
- `src/server.ts` — HTTP plumbing: routing, auth, request ids, JSON errors.
- `src/store.ts` — in-memory store shared by all four surfaces, with a logical clock.
- `src/scenario.ts` — the suite's seeded viewer identity (recomputed from the kit's fixed seed).
- `src/git.ts` — git objects, packfiles, pkt-lines, sideband (SHA-1 + zlib, stdlib only).
- `src/git-http.ts` — git smart HTTP (upload-pack v2, receive-pack v0).
- `src/rest.ts` — REST v3 API.
- `src/graphql.ts` — GraphQL v4.
- `src/mcp.ts` — MCP over streamable HTTP.

---

<sub>Entered on [make.fun](https://make.fun/?ref=trpdktbz&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
