# Web workspace

The console answers three questions in the same window: what needs me, what is running, and what did it change. It renders durable session history from REST and folds newer events from WebSocket, reconnecting from the last sequence number. Text, reasoning, and tool-call previews stay transient until their step settles. Every surface reads the DTOs in `@extendo/contracts`, never the server implementation.

## Status board

The left column groups threads by the state the server derives for each one, in this order: Waiting on you, Working, Queued, In review, Failed, Done, Idle. A row carries the title, one line of what the swarm or the pull request is doing, the time in that state, and the pull request number. Group headings count the whole filtered set, and the existing filter, paging, and roving keyboard focus work inside the grouped list.

## Operation bar

Above the conversation, a state chip, the time in state, the subagent counts, and a Preview button. When the branch has a pull request, its card sits under that row: number, title, checks, review decision, diffstat, and a Merge action when the pull request is open and not a draft. A delegated run that is blocked on a decision raises a banner here, so the approval is visible without opening the panel.

## Conversation, steering, approvals

Sending while a turn runs steers it; sending while a turn is queued for a subagent queues it. The composer keeps the stop control beside the send control so a person can interrupt or redirect without a mode switch. A tool that needs approval blocks its step until the card in the conversation is answered; a subagent's approval blocks in the same way and is answered from the panel.

## Work panel

Tabs: Overview (plan, changed files, recent activity), Subagents (Running, Waiting on you, Queued, Failed, Stopped, Done, each with role, timing, activity lines with durations, report or error, steer and stop controls), Changes, Terminal, and Preview. Preview iframes the branch's page rendered by `GET /api/preview/:sessionId`.

Use `pnpm dev` for Vite with a loopback API and WS proxy. Visit `/?data=demo` in Vite to expose the development-only stress selector. Its Worst case fixture puts 1,284 sessions across every state, expanded German labels, non-Latin titles, long subagent activity labels, a failed subagent with a long error, and pull requests with failing checks through the same presentation components. Empty and One check collection boundaries. Production builds have no stress selector.
