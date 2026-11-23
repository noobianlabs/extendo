# Extendo architecture

Extendo runs locally on Node 24. Its CLI and local Hono server compose the same plugins; the browser consumes public DTOs and RPC frames from [@extendo/contracts](../packages/contracts/src/index.ts), never the SQLite store or provider internals. This architecture takes the reversible plugin ownership and composed profiles from DeepSeek Harness, and the thread-centric, shared-surface model from bb.

## Kernel and profiles

A `Plugin` has a name and an `apply(ctx)` function. Register services, listeners and resources through the context. Unmounting disposes plugin-owned scopes and effects once in reverse order, including any disposer returned by `apply`. A failed batch unwinds only the plugins mounted by that batch. Plugins mounted in the same scope share its registry; `ctx.fork(name)` inherits ancestor capabilities but keeps its local registrations private from its parent and siblings. `inject` attaches an effect when all named services are available, unmounts it when dependencies disappear or change, and can attach it again after a replacement.

`emit` broadcasts without awaiting; `serial` awaits listeners in order. Listeners run ancestor-first, then in registration order. A waterfall listener can delegate with `next(payload)` exactly once and can transform the result on return; omitting `next` short-circuits downstream subscribers and the fallback. Plugin and contract vocabulary is shared across surfaces:

| Kind | Names |
| --- | --- |
| Durable | `session/created`, `turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `assistant/message`, `assistant/attempt`, `tool/call`, `tool/result`, `context/compacted`, `subagent/spawned`, `subagent/queued`, `subagent/started`, `subagent/activity`, `subagent/report`, `subagent/steered`, `subagent/approval`, `subagent/approval-answered` |
| Live | `session/event`, `agent/status`, `agent/error`, `assistant/delta`, `assistant/tool-call`, `tool/approval`, `tool/approval-answered`, `pull-request/updated`, `thread/updated` |
| Waterfall | `agent/pre-step`, `agent/request`, `llm/stream`, `tools/pre-execute`, `tools/execute`, `tools/post-execute` |
| Capability seams | `fs/read`, `fs/write`, `tools/register`, `llm/register`, `telemetry/event` |

A profile applies its bundle rows in stack order, then applies its patch layers. A patch replaces an entire row by id at the same position; new ids append and `{ "id": "...", "remove": true }` deletes a row. `enabled: false` leaves a row visible in the dump but skips mounting. Boot and config dump use the same composition. Profile configuration is non-secret JSON; credentials are separate.

## Sessions and turns

SQLite is authoritative; rows are appended per session with sequence numbers starting at 1. Every persisted row has `seq`, `ts`, `type` and discriminated `data`. `session/event` broadcasts committed rows as `{ sessionId, event }`. A JSONL file per session mirrors the same rows and can be rebuilt from SQLite after a crash. Reopening an interrupted session appends missing tool settlements and end markers, but never assumes that an external side effect did not happen or retries it automatically.

The message projection groups tool calls and results under their assistant step. Clients can render historical data by loading the session snapshot or folding its ordered events, then attach transient text/reasoning deltas by `messageId`. Failed partial assistant attempts are retained for diagnostics and don't enter ordinary model history. A turn can have no steps if an input is rejected; each admitted step performs one model stream and settles that step's calls before the next model request. Tools declare a Zod input schema, which is also converted to model-facing JSON Schema. Providers return an async stream of text, reasoning, tool-call, usage, completion or error chunks.

## Delegated work

Delegation is a child session running a real turn, not a second orchestration loop. `@extendo/swarm` registers the `delegate` tool with a run queue per parent session; a spawned run appends `subagent/spawned`, waits its turn with `subagent/queued` plus a position, and starts with `subagent/started`. The child's own tool calls and results become `subagent/activity` lines with measured durations, its last assistant message becomes the `subagent/report`, and a child approval is forwarded as `subagent/approval`. `subagent-steer` reaches a running or approval-blocked child through `AgentRuntime.steer`; `subagent-stop` cancels it or drops it from the queue.

The parent's log is the only source of truth: `projectSubagents` folds those events back into the swarm the console renders, so a reload reconstructs exactly what was on screen. `deriveThreadState` then answers what the thread needs from a person, in this order: a waiting approval, an open turn or running run, a queued run, a pull request waiting on review, then the last turn's outcome.

## Pull requests and previews

`@extendo/pullrequests` reads the open pull request for a thread's branch, either through `gh pr view` or from a scripted reader for the keyless demo. The server's `ThreadViewer` joins three things per thread: the stored row, the derived state plus swarm, and the pull request, caching the read for twenty seconds and the derivation until the session's last sequence number changes. `pull-request-merge` merges only when the reader supports it. `GET /api/preview/:sessionId` renders the branch's page from the demo workspace, and the console iframes it beside the review.

## RPC and HTTP

The WebSocket endpoint is `/ws`. Requests are `{ id, method, params }` and responses are `{ id, result }` or `{ id, error: { code, message } }`. Unsolicited messages are `{ event, data }`. IDs are request correlation values; `sessionId` is the stable key for subscription, cancellation, message submission and approval answers.

| Method | Params | Result |
| --- | --- | --- |
| `subscribe` | `sessionId`, optional `afterSeq` | `lastSeq`, live `status`, pending `approvals`; catches up durable events after the cursor |
| `unsubscribe` | `sessionId` | `ok` |
| `send-message` | `sessionId`, `content`, optional `provider`, `model` and `mode` (`auto`, `steer`, `queue`) | `mode` (`started` with `turnId`, `steered`, or `queued`); execution continues on the event channel |
| `cancel` | `sessionId` | `cancelled` |
| `answer-approval` | `sessionId`, `requestId`, `decision` (`allow`, `deny`, `always`) | `accepted`; the session may be a child session |
| `subagent-steer` | `sessionId`, `subagentId`, `message` | `steered` |
| `subagent-stop` | `sessionId`, `subagentId` | `stopped` |
| `pull-request-merge` | `sessionId` | `merged`, and the pull request when the reader returns it |

`thread/updated` carries a whole `Thread` to every socket when a subscribed session appends an event; the server coalesces those snapshots on a 120 ms timer, so the status board, the operation bar, and the swarm move together without a poll. `pull-request/updated` carries a refreshed pull request.

REST clients use `/api/threads` (rows joined with derived state, swarm, and pull request), `/api/projects`, `/api/settings`, `/api/providers`, `/api/sessions/:id` for the message projection, `/api/sessions/:id/events?afterSeq=0` for replay, and `/api/preview/:sessionId` for the branch preview. `/api/health` is the liveness endpoint.

Both transports share one origin decision (`apps/server/src/origin.ts`). A request is accepted when its effective host is loopback and its `Origin` is absent, matches that host, or appears in the allowlist built from `EXTENDO_ALLOWED_ORIGINS` and the Vite dev origins. With `EXTENDO_TRUST_PROXY=1` the forwarded host and protocol are honored when computing the effective host, so a proxied public origin that matches the forwarded host is accepted; without it forwarded headers are ignored. The HTTP guard and the `/ws` upgrade guard call the same function, and a rejection is logged at debug level with the host, origin, and forwarded host.
