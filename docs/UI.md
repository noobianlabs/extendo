# Web workspace

The web app renders durable session history from REST and folds newer events from WebSocket. Reconnects use the last received sequence number. Text, reasoning, and tool-call previews stay transient until the corresponding step settles. The conversation, inspector, and sidebar all read the same normalized data. UI packages should consume `@extendo/contracts`, not the server implementation.

Use `pnpm dev` for Vite with a loopback API and WS proxy. Visit `/?data=demo` in Vite to expose the development-only stress selector. Its Worst case fixture puts 1,284 sessions, expanded German labels, non-Latin titles, a long file path, and a large tool result through the same presentation components. Empty and One check collection boundaries. Production builds have no stress selector.
