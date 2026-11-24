# Web workspace

The console answers three questions in the same window: what needs me, what is running, and what did it change. It renders durable session history from REST and folds newer events from WebSocket, reconnecting from the last sequence number. Text, reasoning, and tool-call previews stay transient until their step settles. Every surface reads the DTOs in `@extendo/contracts`, never the server implementation.

## Status board

The left column groups threads by the state the server derives for each one, in this order: Waiting on you, Working, Queued, In review, Failed, Done, Idle. A row carries the title, one line of what the swarm or the pull request is doing, the time in that state, and the pull request number. Group headings count the whole filtered set, and the existing filter, paging, and roving keyboard focus work inside the grouped list.

## Operation bar

Above the conversation, a state chip, the time in state, the subagent counts, and a Preview button. When the branch has a pull request, its card sits under that row: number, title, checks, review decision, diffstat, and a Merge action when the pull request is open and not a draft. A delegated run that is blocked on a decision raises a banner here, so the approval is visible without opening the panel.

## Conversation, steering, approvals

Sending while a turn runs steers it; sending while a turn is queued for a subagent queues it. The composer keeps the stop control beside the send control so a person can interrupt or redirect without a mode switch. A tool that needs approval blocks its step until the card in the conversation is answered; a subagent's approval blocks in the same way and is answered from the panel.

## The spine and the seam

The transcript is one column, capped at 720px and centred, with a 1px vertical rule at its left edge: the **spine**. Assistant prose hangs to the right of it, a tool call cuts a notch into it, and a user message interrupts it and then resumes it. Reading a thread is reading the substrate's own history rather than a stack of chat bubbles.

When a tool that an authored plugin registered is called for the first time in a thread, the transcript draws a **seam** above that step: a hairline in the accent colour, drawn out from a mono label that names the plugin and the tool. The seam is derived from the session log and the plugin store, never stored as its own event, so it cannot claim a join the log does not show. Clicking it opens the workshop on that plugin.

Mono type is reserved for anything the kernel registered or measured — tool names, plugin ids, paths, timings, token counts — and Inter for anything a person or the model wrote.

## Workshop

The puzzle control in the header opens the workshop, a docked panel on the right that takes the space the transcript gives up, so both are visible at once: plugin tabs, the source in a CodeMirror editor with one accent for keywords, and a footer with the tools the plugin provides, the mount time, and the revision. Save is `⌘S`; a successful save draws a hairline across the footer and the tool appears in the capability strip. A failed save keeps the previous revision running and shows the error under the editor. Below 1100px the panel takes the whole window.

## Capability strip

Above the composer, the strip names the tools a plugin added and counts the built-in ones. A tool that just mounted springs in from the left. It is the always-visible answer to "what can the agent do in this thread right now".

## Work panel

Tabs: Overview (plan, changed files, recent activity), Subagents (Running, Waiting on you, Queued, Failed, Stopped, Done, each with role, timing, activity lines with durations, report or error, steer and stop controls), Changes, Terminal, and Preview. Preview iframes the branch's page rendered by `GET /api/preview/:sessionId`.

**Changes** is the source surface from `GET /api/git/status`, scoped to the thread's checkout: the branch, its upstream, ahead/behind, whether the thread runs in its own worktree or the shared checkout (with the control that creates or removes it), the three change groups with a stage or unstage control per row and per group, an inline CodeMirror merge diff per file, and a sticky commit bar carrying the message field, Commit, Push, and the pull request control or the sentence explaining why it is unavailable. It re-reads the checkout when the tab opens, when a write or shell tool finishes in the thread, every 1.5s while a turn runs, and on demand from its refresh control; stage, commit, push, and worktree actions each return the fresh state with their result, so the panel never shows a status it did not just read. Mutations live under `/api/git/*` in their own Hono app (`apps/server/src/gitApi.ts`), plus `DELETE /api/threads/:id`, which owns worktree cleanup.

Use `pnpm dev` for Vite with a loopback API and WS proxy. Visit `/?data=demo` in Vite to expose the development-only stress selector. Its Worst case fixture puts 1,284 sessions across every state, expanded German labels, non-Latin titles, long subagent activity labels, a failed subagent with a long error, and pull requests with failing checks through the same presentation components. Empty and One check collection boundaries. Production builds have no stress selector.
