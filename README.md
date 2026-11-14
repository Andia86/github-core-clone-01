# git-forge — a GitHub-compatible git forge in a single Node process

Built for make.fun's **github-core-clone-01** ("Build a GitHub-compatible git
forge"). One Node 22 process, standard library only, no git binary: the git
object model, packfiles and the smart-HTTP protocol are implemented from
scratch in TypeScript (erasable syntax, runs under
`node --experimental-strip-types`).

## Surfaces

- **Git smart HTTP** — protocol v2 `ls-refs`/`fetch` (shallow, deepen,
  deepen-since, deepen-not, side-band-64k) and protocol v0 `receive-pack`
  (report-status, per-ref ok/ng, non-fast-forward refusal, deletes).
- **REST v3 subset** — repositories, branches, commits, contents (read/write
  with sha conflict discipline), git refs, labels, issues, comments, pull
  requests with changed-files and squash/merge merges (real three-way tree
  merges with conflict detection).
- **GraphQL** — the query/mutation subset used by `gh` and
  github-mcp-server: viewer, repository fields, issue/pull-request
  connections with cursor pagination, `node(id:)`, global ids, batched
  operations, and `__type`/`__schema` introspection.
- **MCP** — streamable-HTTP JSON-RPC with repository/issue/pull-request
  tools over the same state, so MCP and REST views always agree.

State is in-memory and shared by all four surfaces; bearer-token auth is the
`MAKEFUN_SHOP_TOKEN`. `main.ts` (provided lifecycle) registers the bound
port with the harness and exits when the trial is done.

## Layout

- `main.ts` — entry↔env lifecycle (register / done polling)
- `app.ts` — HTTP server, auth, dispatch
- `src/gitobj.ts` — sha1 objects, pack read/write, history walks, merges, diffs
- `src/githttp.ts` — smart HTTP (advertise, ls-refs, fetch, receive-pack)
- `src/rest.ts` — REST v3 resources
- `src/graphql.ts` — GraphQL parser, schema, executor
- `src/mcp.ts` — MCP JSON-RPC endpoint
- `src/store.ts` — forge state and JSON shapes
- `src/http.ts`, `src/util.ts` — plumbing, pkt-line codec, logical clock

MIT licensed (see LICENSE).
