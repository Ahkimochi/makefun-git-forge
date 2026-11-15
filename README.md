# makefun-git-forge

A GitHub-compatible git forge for [make.fun's github-core-clone-01](https://make.fun/bounty/github-core-clone-01):
one Node process, its own in-memory store, no UI, no `git` binary, no dependencies —
Node 22 standard library only.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry ↔ env lifecycle from the contest starter (bind an ephemeral port,
register it with `$MAKEFUN_ENV_URL`, poll `/done`, exit 0). `app.ts` builds the server;
the trial's bearer token is read from `MAKEFUN_SHOP_TOKEN`, and the trial's clock from
`MAKEFUN_TRIAL_NOW` (never the wall clock), so a run replays deterministically.

## The surface

All four surfaces serve the same store (`store.ts`), so an object created on one reads
back identically on the others:

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`, the env's boot probe |
| `/api/v3/...` | GitHub REST v3 (`rest.ts`): repositories, contents, git refs, branches, commits, labels, issues, comments, pull requests, files, squash merges |
| `/{owner}/{repo}.git/...` | git smart HTTP (`githttp.ts`): protocol v2 upload-pack (advertisement, ls-refs, fetch with shallow/deepen and exact object selection), v0 fallback fetch, v0 receive-pack with report-status |
| `POST /api/graphql` | GitHub GraphQL v4 (`graphql.ts`): viewer/repository/node, issue & pull-request connections with cursors, the five mutations the suite sends, batched operations, and introspection of the named types |
| `POST /mcp` | Model Context Protocol (`mcp.ts`): modern `server/discover` era (plus the legacy initialize handshake), six tools — create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request |

Git objects are content-addressed SHA-1 exactly as git computes them (`gitobj.ts`:
trees, commits, tags, pkt-lines, packfiles with delta resolution), so ids the suite
builds match ids the forge builds. Fetches send precisely the objects the client lacks —
commits it has not reached, minus every tree and blob it already holds.

## Layout

- `main.ts` — the lifecycle (from the starter, unchanged)
- `app.ts` — the HTTP server: routing, token auth, request ids
- `store.ts` — the one store, plus history walks, merge-base and the three-way file merge
- `gitobj.ts` — the git object model and packfile codec
- `githttp.ts` — the smart-HTTP protocol
- `rest.ts` — REST v3, plus the create/merge operations the other surfaces share
- `graphql.ts` — a small GraphQL parser/executor and the schema the suite introspects
- `mcp.ts` — the MCP endpoint and its tools
- `BUILDLOG.md` — the build's grade history

MIT licensed (see `LICENSE`).
