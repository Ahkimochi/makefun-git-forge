# Build log — make.fun github-core-clone-01 entry

A GitHub-compatible git forge in pure Node stdlib (no git binary, no dependencies):
`gitobj.ts` (object ids, trees, commits, tags, pkt-lines, packfiles), `store.ts` (the one
store + history/merge machinery), `rest.ts` (REST v3), `githttp.ts` (smart HTTP: v2
upload-pack, v0 receive-pack), `graphql.ts` (GraphQL v4), `mcp.ts` (MCP, modern era),
`app.ts` (the server wiring), `main.ts` (the kit starter's lifecycle, unchanged).

## Grades (grade-local --driver process)

- Pre-grade smoke (kit's own GitClient/RestClient against the dev server, 41 assertions
  over REST, git push/clone/shallow/non-FF, PR merge, GraphQL, MCP): ALL PASS.

- **Grade 1 (commit ac7b991): 935/1000** — feature 595 (119/120), agent 200 (15/15 MCP),
  perf 140 (push p50 803 ms / 38, clone 213 ms / 29, read 1548 ms / 35, write 169 ms / 38;
  T_ref 1641 / 267 / 2760 / 349 ms). Replay matched byte for byte. Only failure:
  git.fetch-incremental — the fetch re-sent unchanged trees/blobs of the new commit's
  closure; the check demands the exact new-object set.
- Fix: the fetch plan now computes the client's held set at object granularity (its
  commits plus their whole tree closures) and excludes it from the pack; pack reading
  finds deflate ends with a growth-then-binary search (fewer inflate probes per object).
- **Grade 2 (commit 007dd2f): 938/1000 — feature 600 (120/120), agent 200 (15/15), perf
  138** (push p50 864 ms / 37, clone 254 ms / 26, read 1346 ms / 38, write 179 ms / 37).
  Conformance and MCP are complete; the perf column moves with sandbox CPU noise
  (138–140 across the two runs) and every workload beats its T_ref locally.
- **Grade 3 (final): 952/1000 — feature 600 (120/120), agent 200, perf 152** (push p50
  760 ms / 39, clone 153 ms / 35, read 1216 ms / 40, write 174 ms / 38). Third run,
  same verdict: the full conformance surface and the MCP column are complete, the
  replay matched byte for byte every time, and all four workloads beat the house
  reference times (T_ref 1641 / 267 / 2760 / 349 ms) on this machine.
