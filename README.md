# Extendo

A local-first coding workspace built around a typed plugin kernel. Requires Node 24 and pnpm. You don't need a model account or API key to try it.

```sh
pnpm install
pnpm dev
```

Open **http://127.0.0.1:5173**. Extendo starts with a Northstar UI demo conversation. Send a follow-up to watch it stream a proposed edit, approve or deny that step, and see the result in the conversation and inspector. Demo reads, edits, and tests are simulated.

For the built application:

```sh
pnpm build
pnpm test
node packages/cli/dist/index.js web --port 4310
node packages/cli/dist/index.js headless "say hello" --provider demo
```

Opening a project attaches a local directory; v0.1 does not create or manage Git worktrees. Extendo listens on loopback, stores workspace and session data under `~/.extendo` unless `EXTENDO_HOME` is set, and does not store provider keys in the workspace. Shell commands run as your user and are not sandboxed. Review every write or shell approval before allowing it.

See [Architecture](docs/ARCHITECTURE.md), [Plugins](docs/PLUGINS.md), [Providers](docs/PROVIDERS.md), and [Web workspace](docs/UI.md).
