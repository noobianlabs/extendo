# Plugins

Every capability mounts through the same kernel. A plugin calls `apply(ctx)` once on mount, and registrations made through the context unwind in reverse order. Use `ctx.inject(['tools', 'commands'], apply)` if you depend on services that might not yet exist. Its effect is cleaned up when a dependency disappears and mounted again when services return.

Start with [hello-plugin](../examples/hello-plugin/src/index.ts). It declares a read-only tool with a Zod schema and a human command that doesn't need a model. It registers both against the injection context, not the host context, so unmount removes both. Its [test](../examples/hello-plugin/src/index.test.ts) exercises the real loader. Tool names should be short and unique; tools that change state or leave the local workspace should declare `needsApproval: true`.

## Authoring a plugin inside the app

The **workshop** is the in-app editor for the plugin you are writing: the puzzle control in the header, or "Open the workshop" in the command palette. It docks beside the transcript, so the whole loop is visible in one window: write a plugin, save it, and the agent calls its tool in the thread you are already in.

A plugin authored there is one file, `$EXTENDO_HOME/plugins/<id>/index.mjs`, beside a `plugin.json` manifest. It **has no imports**. The host hands the file an SDK, so there is nothing to resolve and nothing to install:

```js
export default ({ tool, z }) => ({
  name: 'Word count',
  apply(ctx) {
    const count = tool({
      name: 'word_count',
      description: 'Count the words and characters in a piece of text.',
      input: z.object({ text: z.string().min(1).max(20000) }),
      readOnly: true,
      async execute({ text }) {
        const words = text.trim().split(/\s+/).filter(Boolean);
        return { words: words.length, characters: text.length };
      },
    });
    ctx.get('tools').register(ctx, count.name, count);
    ctx.emit('tools/register', { name: count.name });
  },
});
```

The default export is a factory that receives `{ tool, z, definePlugin }`. `tool()` is an identity function over the `Tool` in `@extendo/contracts`, and `z` is the host's zod, so an authored plugin's schema goes to the model as JSON Schema exactly like a built-in one. A plain `Plugin` object is also accepted as the default export.

### What saving does

1. The file is written as a new revision and imported from a URL that carries that revision, so Node never reuses the module it loaded for the previous one.
2. The module is instantiated and validated. If it throws or does not look like a plugin, the file is restored to the previous revision and the running one is left alone.
3. Only then is the previous mount disposed and the new one mounted. Its tools are the difference in the registry, which is how the workshop knows what a plugin provides and how the capability strip attributes it.
4. If the mount itself fails — a duplicate tool name, an exception in `apply` — the previous revision is mounted again and the panel shows the error.

A failed save therefore never leaves broken code on disk and never takes the working plugin out of the kernel. Revisions only move forward, so a revision number that failed once is not replayed from the module cache.

### Lifecycle

Plugins on disk mount when the server starts; one that cannot load is reported in the workshop and does not stop the boot. `$EXTENDO_HOME/plugins/mounts.jsonl` is an append-only record of every plugin joining the kernel. The **seam** in the transcript — the accent hairline that names a plugin and its tool — is derived from the session log plus that record, not stored as its own event, so it can only claim a join the log actually shows.

### HTTP

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/extensions` | Every authored plugin with its source, revision, live tools and error, plus the mount log |
| `GET` | `/api/extensions/tools` | Every tool the model is offered next, with the plugin that provided it |
| `POST` | `/api/extensions` | Create from a name; answers with the template already mounted |
| `PUT` | `/api/extensions/:id` | Save a revision and hot-swap it; `422` carries the error and the previous revision |
| `DELETE` | `/api/extensions/:id` | Unmount and delete |

These routes answer under the same origin policy as the rest of the server. Authored plugins are **trusted in-process code**, exactly like the packages below.

## Installed packages

A plugin package exports a default `Plugin` (or a factory taking its JSON config) from the file named in its package manifest:

```json
{
  "name": "@your-scope/plugin-name",
  "version": "0.1.0",
  "type": "module",
  "extendo": { "server": "./dist/index.js" }
}
```

`extendo plugin add @your-scope/plugin-name` installs a named package into the local extensions directory and activates it on the next launch. Extensions are **trusted in-process code**, not sandboxed. Installation disables dependency scripts; mounting still runs the plugin, so install only reviewed packages. UI extension loading is not part of this release.

`extendo --dump-config` shows the selected profile without importing installed plugin entry points. To override a built-in or installed plugin, write an array of rows to `$EXTENDO_HOME/profile.json` (default home: `~/.extendo`) or pass `--patch file.json`; later overlays win. For example, `[{ "id": "workspace-tools", "remove": true }]` removes the standard tools on that launch. Config should contain no credentials.
