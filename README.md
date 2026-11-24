# Extendo

A local-first coding workspace built around a typed plugin kernel. Requires Node 24 and pnpm. You don't need a model account or API key to try it.

```sh
pnpm install
pnpm dev
```

Open **http://127.0.0.1:5173**. Extendo starts with a Northstar UI demo workspace. The left status board groups threads by what they need — waiting on you, working, queued, in review, failed, done, idle. Open the audit thread and send *Run the three tracks in parallel* to watch a delegated swarm: three child sessions, one running at a time, a patch track that blocks for your approval, a queued track that starts when its turn comes, and steering controls on every running subagent. The preview tab renders the branch's search page; the pull request card shows checks and review state. Demo reads, edits, checks, and pull requests are simulated, and none of them touch your files.

For the built application:

```sh
pnpm build
pnpm test
node packages/cli/dist/index.js web --port 4310
node packages/cli/dist/index.js headless "say hello" --provider demo
```

Opening a project attaches a local directory. The demo workspace is a real git repository with a bare
`origin` under `~/.extendo`, real branches, and one worktree per seeded thread, so the Changes tab shows
actual git state rather than a picture of it.

The Changes tab in the right panel is the working tree of the checkout the active thread is in: branch,
upstream, ahead/behind, files grouped staged/changes/untracked, a diff per file, stage and unstage,
commit with a message, push, and open a pull request. A thread can run in its own `git worktree` on its
own branch — from the command palette ("New thread in its own worktree"), or from the worktree row in
that panel — so two threads never edit one checkout. Removing a worktree or deleting a thread first asks
a confirmation that names the uncommitted files it would destroy.

Extendo never force-pushes, and never stages `.env`-style paths, private keys, or credential files
unless you say so twice. Pushing needs a remote named `origin`; opening a pull request needs `gh`
installed and signed in, and when either is missing the panel says what is missing instead of offering a
button that cannot work. The web console reads existing pull requests through `gh` when it runs against
a real repository, and a failed read leaves the card out rather than blocking the thread.

Extendo listens on loopback, stores workspace and session data under `~/.extendo` unless `EXTENDO_HOME`
is set, and does not store provider keys in the workspace. Shell commands run as your user and are not
sandboxed. Review every write or shell approval before allowing it.

## Running behind a proxy or tunnel

Extendo accepts a request only when its `Host` is loopback and its `Origin` is absent, matches that host, or is in an allowlist. A tunnel or preview proxy that rewrites `Host` (Cloudflare Tunnel, ngrok, a sandbox preview proxy) therefore needs the public origin the browser uses:

```sh
# the exact origin the browser sends, comma-separated when there are several
EXTENDO_ALLOWED_ORIGINS=https://extendo.example.com node packages/cli/dist/index.js web --port 4310

# the same through the CLI
node packages/cli/dist/index.js web --port 4310 --allow-origin https://extendo.example.com

# add this when the proxy also rewrites Host and forwards x-forwarded-host
EXTENDO_TRUST_PROXY=1 node packages/cli/dist/index.js web --port 4310 --allow-origin https://extendo.example.com
```

`--allow-origin` and `EXTENDO_ALLOWED_ORIGINS` take exact origins only, as `scheme://host[:port]`; wildcards and paths are ignored. With `EXTENDO_TRUST_PROXY=1` (or `--trust-proxy`) Extendo trusts `x-forwarded-host` and `x-forwarded-proto` when it checks the origin, so a public origin that matches the forwarded host is accepted. Without it those headers are ignored, so a loopback-only server cannot be spoofed. A rejected request is logged at debug level with its host, origin, and forwarded host. `pnpm dev` keeps working as before: the Vite dev origins are always allowed.

See [Architecture](docs/ARCHITECTURE.md), [Plugins](docs/PLUGINS.md), [Providers](docs/PROVIDERS.md), and [Web workspace](docs/UI.md).
