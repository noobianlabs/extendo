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

Opening a project attaches a local directory; Extendo does not create or manage Git worktrees. The web console reads pull requests through `gh` when it runs against a real repository, and a failed read leaves the card out rather than blocking the thread. Extendo listens on loopback, stores workspace and session data under `~/.extendo` unless `EXTENDO_HOME` is set, and does not store provider keys in the workspace. Shell commands run as your user and are not sandboxed. Review every write or shell approval before allowing it.

See [Architecture](docs/ARCHITECTURE.md), [Plugins](docs/PLUGINS.md), [Providers](docs/PROVIDERS.md), and [Web workspace](docs/UI.md).
