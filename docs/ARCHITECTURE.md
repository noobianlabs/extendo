# Extendo architecture

Extendo runs locally on Node 24. Its CLI and local Hono server compose the same plugins; the browser consumes public DTOs and RPC frames from [@extendo/contracts](../packages/contracts/src/index.ts), never the SQLite store or provider internals. This architecture takes the reversible plugin ownership and composed profiles from DeepSeek Harness, and the thread-centric, shared-surface model from bb.

## Kernel and profiles

A `Plugin` has a name and an `apply(ctx)` function. Register services, listeners and resources through the context. Unmounting disposes plugin-owned scopes and effects once in reverse order, including any disposer returned by `apply`. A failed batch unwinds only the plugins mounted by that batch. Plugins mounted in the same scope share its registry; `ctx.fork(name)` inherits ancestor capabilities but keeps its local registrations private from its parent and siblings. `inject` attaches an effect when all named services are available, unmounts it when dependencies disappear or change, and can attach it again after a replacement.

`emit` broadcasts without awaiting; `serial` awaits listeners in order. Listeners run ancestor-first, then in registration order. A waterfall listener can delegate with `next(payload)` exactly once and can transform the result on return; omitting `next` short-circuits downstream subscribers and the fallback. Plugin and contract vocabulary is shared across surfaces:

| Kind | Names |
| --- | --- |
| Durable | `session/created`, `turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `assistant/message`, `assistant/attempt`, `tool/call`, `tool/result`, `context/compacted` |
| Live | `session/event`, `agent/status`, `agent/error`, `assistant/delta`, `assistant/tool-call`, `tool/approval`, `tool/approval-answered` |
| Waterfall | `agent/pre-step`, `agent/request`, `llm/stream`, `tools/pre-execute`, `tools/execute`, `tools/post-execute` |
| Capability seams | `fs/read`, `fs/write`, `tools/register`, `llm/register`, `telemetry/event` |

A profile applies its bundle rows in stack order, then applies its patch layers. A patch replaces an entire row by id at the same position; new ids append and `{ "id": "...", "remove": true }` deletes a row. `enabled: false` leaves a row visible in the dump but skips mounting. Boot and config dump use the same composition. Profile configuration is non-secret JSON; credentials are separate.

## Sessions and turns

SQLite is authoritative; rows are appended per session with sequence numbers starting at 1. Every persisted row has `seq`, `ts`, `type` and discriminated `data`. `session/event` broadcasts committed rows as `{ sessionId, event }`. A JSONL file per session mirrors the same rows and can be rebuilt from SQLite after a crash. Reopening an interrupted session appends missing tool settlements and end markers, but never assumes that an external side effect did not happen or retries it automatically.

The message projection groups tool calls and results under their assistant step. Clients can render historical data by loading the session snapshot or folding its ordered events, then attach transient text/reasoning deltas by `messageId`. Failed partial assistant attempts are retained for diagnostics and don't enter ordinary model history. A turn can have no steps if an input is rejected; each admitted step performs one model stream and settles that step's calls before the next model request. Tools declare a Zod input schema, which is also converted to model-facing JSON Schema. Providers return an async stream of text, reasoning, tool-call, usage, completion or error chunks.

## RPC and HTTP

The WebSocket endpoint is `/ws`. Requests are `{ id, method, params }` and responses are `{ id, result }` or `{ id, error: { code, message } }`. Unsolicited messages are `{ event, data }`. IDs are request correlation values; `sessionId` is the stable key for subscription, cancellation, message submission and approval answers.

| Method | Params | Result |
| --- | --- | --- |
| `subscribe` | `sessionId`, optional `afterSeq` | `lastSeq`, live `status`, pending `approvals`; catches up durable events after the cursor |
| `unsubscribe` | `sessionId` | `ok` |
| `send-message` | `sessionId`, `content`, optional `provider` and `model` | `turnId`; execution continues on the event channel |
| `cancel` | `sessionId` | `cancelled` |
| `answer-approval` | `sessionId`, `requestId`, `decision` (`allow`, `deny`, `always`) | `accepted` |

REST clients use `/api/threads`, `/api/projects`, `/api/settings`, `/api/providers`, `/api/sessions/:id` for the message projection, and `/api/sessions/:id/events?afterSeq=0` for replay. `/api/health` is the liveness endpoint.
