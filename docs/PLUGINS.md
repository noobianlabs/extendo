# Plugins

Every capability mounts through the same kernel. A plugin calls `apply(ctx)` once on mount, and registrations made through the context unwind in reverse order. Use `ctx.inject(['tools', 'commands'], apply)` if you depend on services that might not yet exist. Its effect is cleaned up when a dependency disappears and mounted again when services return.

Start with [hello-plugin](../examples/hello-plugin/src/index.ts). It declares a read-only tool with a Zod schema and a human command that doesn't need a model. It registers both against the injection context, not the host context, so unmount removes both. Its [test](../examples/hello-plugin/src/index.test.ts) exercises the real loader. Tool names should be short and unique; tools that change state or leave the local workspace should declare `needsApproval: true`.

A plugin package exports a default `Plugin` (or a factory taking its JSON config) from the file named in its package manifest:

```json
{
  "name": "@your-scope/plugin-name",
  "version": "0.1.0",
  "type": "module",
  "extendo": { "server": "./dist/index.js" }
}
```

`extendo plugin add @your-scope/plugin-name` installs a named package into the local extensions directory and activates it on the next launch. Extensions are **trusted in-process code**, not sandboxed. Installation disables dependency scripts; mounting still runs the plugin, so install only reviewed packages. UI extension loading and hot reload are not part of this release.

`extendo --dump-config` shows the selected profile without importing installed plugin entry points. To override a built-in or installed plugin, write an array of rows to `$EXTENDO_HOME/profile.json` (default home: `~/.extendo`) or pass `--patch file.json`; later overlays win. For example, `[{ "id": "workspace-tools", "remove": true }]` removes the standard tools on that launch. Config should contain no credentials.
