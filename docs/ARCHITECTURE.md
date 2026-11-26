# Extendo architecture

Extendo runs locally on Node 24. Its CLI and local Hono server compose the same plugins; the browser consumes public DTOs and RPC frames from [@extendo/contracts](../packages/contracts/src/index.ts), never the SQLite store or provider internals. This architecture takes the reversible plugin ownership and composed profiles from DeepSeek Harness, and the thread-centric, shared-surface model from bb.

## Kernel and profiles

A `Plugin` has a name and an `apply(ctx)` function. Register services, listeners and resources through the context. Unmounting disposes plugin-owned scopes and effects once in reverse order, including any disposer returned by `apply`. A failed batch unwinds only the plugins mounted by that batch. Plugins mounted in the same scope share its registry; `ctx.fork(name)` inherits ancestor capabilities but keeps its local registrations private from its parent and siblings. `inject` attaches an effect when all named services are available, unmounts it when dependencies disappear or change, and can attach it again after a replacement.

`emit` broadcasts without awaiting; `serial` awaits listeners in order. Listeners run ancestor-first, then in registration order. A waterfall listener can delegate with `next(payload)` exactly once and can transform the result on return; omitting `next` short-circuits downstream subscribers and the fallback. Plugin and contract vocabulary is shared across surfaces:

| Kind | Names |
| --- | --- |
| Durable | `session/created`, `turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `assistant/message`, `assistant/attempt`, `tool/call`, `tool/result`, `context/compacted`, `subagent/spawned`, `subagent/queued`, `subagent/started`, `subagent/activity`, `subagent/report`, `subagent/steered`, `subagent/approval`, `subagent/approval-answered`, `crew/wake`, `crew/steer`, `crew/land` |
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

## Captains and crews

A thread has a role: `standalone`, `captain`, or `worker`. A captain does not run the crew in its own turn; it starts worker threads and each worker runs an ordinary turn in its own git worktree and branch, with a write approved only when the path stays inside that worktree. `apps/server/src/crew.ts` owns the `crew.create`, `crew.list`, `crew.read`, `crew.message`, `crew.wait`, and `crew.archive` tools, the issue tools, and the role instructions each session's system prompt carries. The crew cap defaults to four concurrent workers, and it counts the workers that are not archived, so archiving is the way to make room.

The durable spine is the captain's own log. When a worker's turn ends, `CrewService` writes the worker's last assistant message onto the worker's thread row as its report, commits whatever the worker left in its worktree, and appends a `crew/wake` event to the captain's log carrying the worker, the turn, the outcome and the report. That event projects into a `notice` message, so the captain's transcript shows what each worker reported. A wake starts the captain's next turn only when the captain is idle; a captain that is already working, typically because it was inside `crew.wait`, simply reads the report when its turn continues, and `crew.wait` resolves its tool call in the same turn.

The wake is idempotent by `(workerId, turnId)`, and the service reconciles on boot: it reads every worker's last `turn/end`, appends the wake a captain's log is missing, and delivers the wakes its log holds past the captain's last turn end. A completion that happened before a restart still wakes the captain exactly once, and a captain does not wake again for a turn it already answered. Issues are the other durable record: a row in `workspace.sqlite` with a per-project number, a state (`open`, `in-progress`, `needs-you`, `in-review`, `done`, `canceled`), and optional captain, assignee and parent links, plus comments, so work that outlives a turn outlives the process too.

### Reviewing, landing and steering

A worker's row carries the branch it was cut from and the commit that branch pointed at (`base`, `baseCommit`). `crew.diff` measures the branch from that fork commit — `git diff <fork>..<branch>` plus the commits between them, with both versions of every changed path read out of git — so the review is what the worker wrote, and it survives a landing: measuring from `merge-base(base, branch)` instead would collapse onto the branch tip once the target absorbed it and report an empty diff. A branch with no commit the fork point does not already carry returns `empty: true`, and the surface says so rather than drawing a zero-file diff that reads like zero work.

`crew.land` (and `POST /api/crew/:id/integrate`) lands a worker branch on that base branch through `@extendo/git`'s `integrate`: `git merge-tree --write-tree` performs the merge in git's scratch state and names the paths it could not settle, and only a clean result is applied — a fast-forward (`git merge --ff-only`) when the target is already an ancestor, otherwise a real merge commit with both parents. A conflict is refused with its paths and the target stays at the commit it had; nothing force-moves a ref, no history is rewritten, and no conflict is resolved automatically. A target whose checkout has uncommitted work is refused before anything happens. Landing does not delete anything: the worker's branch and worktree stay until a person removes them explicitly from the Changes tab. The fact of the landing is a `crew/land` event in the captain's log, which projects into a notice and into the worker's row.

Steering has two modes, and both are durable facts in the worker's own log (`crew/steer`) rather than a UI hint. `queue` goes through `AgentRuntime.steer` and is delivered at the worker's next step boundary as a user message, exactly once. `interrupt` goes through `AgentRuntime.interrupt`, which cancels the running turn, waits for it to settle, and starts a new turn with the message; the cancelled turn keeps its own `turn/end` with outcome `cancelled` and its partial text stays in `assistant/attempt`, so it never enters the model's history as a completed answer and `CrewService` does not commit its worktree. `POST /api/crew/:id/steer` answers with which of `queue`, `interrupt`, or `turn` (the worker was idle) actually happened, because a race between a status read and the send has to be visible to the caller.

## Pull requests and previews

`@extendo/pullrequests` reads the open pull request for a thread's branch, either through `gh pr view` or from a scripted reader for the keyless demo. The server's `ThreadViewer` joins three things per thread: the stored row, the derived state plus swarm, and the pull request, caching the read for twenty seconds and the derivation until the session's last sequence number changes. `pull-request-merge` merges only when the reader supports it. `GET /api/preview/:sessionId` renders the branch's page from the demo workspace, and the console iframes it beside the review.

## Authored plugins

`ExtensionWorkshop` in `apps/server/src/extensions.ts` owns the plugins a person writes in the app. It keeps `$EXTENDO_HOME/plugins/<id>/` (an `index.mjs` and a `plugin.json` manifest), imports each revision from a revision-stamped module URL, and swaps it into the same `PluginLoader` the built-in profile uses. Because the agent reads the tool registry on every step, a plugin's tools join the next model request with no restart and no second code path.

Two properties make it safe to save from the app. A revision is imported and validated *before* the previous mount is disposed, so a syntax error, a bad export, or a throwing factory leaves the running plugin untouched and restores the file on disk. A revision that fails while mounting re-mounts the previous one. Revision numbers only increase, so a module URL is never reused after a failure.

The workshop reports what a plugin provides by diffing the tool registry around a mount, which is also how `GET /api/extensions/tools` attributes each live tool to the plugin that added it. `mounts.jsonl` is an append-only record of every join; the console derives the transcript's seam from it plus the session log rather than adding an event to the session vocabulary.

Its HTTP surface is its own Hono app (`apps/server/src/extensionApi.ts`) dispatched ahead of the console app on `/api/extensions`, sharing the same `OriginPolicy` the HTTP guard and the `/ws` upgrade use.

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

`thread/updated` also carries a captain's snapshot when one of its workers changes, because a captain's crew row shows that worker's state and steering, and the browser subscribes to the captain's session, not the worker's. Without it a captain sitting on its own page would never see a worker start, take a steer, or finish without reloading.

REST clients use `/api/threads` (rows joined with derived state, swarm, and pull request), `/api/projects`, `/api/settings`, `/api/providers`, `/api/sessions/:id` for the message projection, `/api/sessions/:id/events?afterSeq=0` for replay, and `/api/preview/:sessionId` for the branch preview. `/api/health` is the liveness endpoint.

The crew's own HTTP surface is `apps/server/src/crewApi.ts`, dispatched ahead of the console app on `/api/crew`: `GET /api/crew/:threadId/diff` for a worker's branch review, `POST /api/crew/:threadId/integrate` for landing it, and `POST /api/crew/:threadId/steer` for a message with its mode. Each mutation answers with the captain's refreshed thread, so the row changes on the same response instead of waiting for the next snapshot.

Both transports share one origin decision (`apps/server/src/origin.ts`). A request is accepted when its effective host is loopback and its `Origin` is absent, matches that host, or appears in the allowlist built from `EXTENDO_ALLOWED_ORIGINS` and the Vite dev origins. With `EXTENDO_TRUST_PROXY=1` the forwarded host and protocol are honored when computing the effective host, so a proxied public origin that matches the forwarded host is accepted; without it forwarded headers are ignored. The HTTP guard and the `/ws` upgrade guard call the same function, and a rejection is logged at debug level with the host, origin, and forwarded host.
