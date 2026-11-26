# Extendo design

Status: v0.3. These are decisions, not options. The identity exists to make one claim visible:
**the harness, the editor, and the extensions are one substrate.** A product that says that cannot
look like a generic chat app with a sidebar. It has to look like one material, marked where new
material has been joined to it.

## The idea: one substrate, marked by seams

Extendo is a single running context. Threads, tools, panels, and plugins all mount into it. So the
interface is built as **one continuous surface** — one background, hairline separations, no floating
cards — and every place where something was added after the fact is drawn as a **seam**: a hairline in
the accent colour, with a mono label saying what was joined and when.

Two consequences you can see in a screenshot:

1. **The spine.** The transcript is not a column of bubbles. Every conversation row hangs off a 1px
   vertical rule at the left edge of the transcript column. Assistant prose sits to the right of it.
   A tool call is a small notch cut into the spine. A plugin mount is a seam that cuts *across* the
   spine in the accent colour. Scrolling a thread is reading the substrate's own history.
2. **Mono means "the substrate knows this".** Tool names, plugin ids, file paths, timings, token
   counts, and capability labels are set in Geist Mono at 12px. Prose is Inter. This is a rule, not a
   decoration: if a string is something the kernel registered or measured, it is mono; if a person or
   the model wrote it, it is Inter. It makes the two kinds of text legible at a glance.

## Colour: neutral, plus one

One accent, **sodium** — a warm amber. Not blue: every agent product is blue or violet, and blue
reads as "a SaaS app". Amber reads as a lit seam, a join being welded, something being added. It is
used for exactly four things, and nothing else in the product may use it:

| Use | Token | Why |
| --- | --- | --- |
| Focus ring | `--accent` | The keyboard is the primary input; the ring is where the substrate answers. |
| Plugin seams and plugin-provided tools | `--accent` | The seam is the product's signature. |
| Live/waiting-on-you status | `--accent` | The one thing that wants a person. |
| Keywords in the workshop editor | `--accent` | The editor is where a join is written; the only coloured token in a plugin. |
| The single solid button per surface | `--accent-fill` | One filled control per screen, never two. The sidebar's New thread is that control whenever it is on screen, so a panel's primary action is an accent hairline instead. |

Everything else is a neutral ramp, stepping lighter with elevation in dark mode and darker in light
mode. Failure gets a desaturated red as a 6px dot and a hairline, never as a fill. Success gets a dot
and nothing else. There is no gradient anywhere in the app, and no colour used to decorate.

Both themes are designed, not inverted: light uses a slightly cool paper (`#F4F4F5`), dark a warm
near-black (`#0A0A0B`), and the accent darkens to `#A9540E` in light mode so it still passes contrast
as text.

## Type

Inter for prose and controls, Geist Mono for anything the substrate knows. Six steps, size-specific
tracking (negative as it grows, slightly positive at the smallest size), leading that tightens with
size. Nothing in the product uses a size outside this scale.

| Token | Size / line-height | Tracking | Weight | Use |
| --- | --- | --- | --- | --- |
| `--type-micro` | 11 / 14 | +0.06em, uppercase | 560 | Mono capability labels and column headings |
| `--type-caption` | 12 / 16 | -0.005em | 450 | Secondary rows, timings, hints |
| `--type-mono` | 12 / 16 | 0 | 450 | Identifiers and measured values that are read as a sentence, such as the seam label and the tool name in a plugin's tool row |
| `--type-body` | 13 / 20 | -0.008em | 450 | Prose, controls, list rows |
| `--type-lead` | 15 / 22 | -0.012em | 460 | Composer input, message lead-ins |
| `--type-title` | 19 / 25 | -0.018em | 560 | Thread title, panel titles, empty-state headings |
| `--type-display` | 26 / 30 | -0.028em | 560 | One per screen at most: the workshop's headline |

## Motion

Motion explains a change of state; it never decorates. Three durations, two curves, and springs only
where something can be interrupted.

- `--ease-out: cubic-bezier(.23, 1, .32, 1)` for anything entering or responding.
- `--ease-in-out: cubic-bezier(.77, 0, .175, 1)` for on-screen movement.
- `--ease-seam: cubic-bezier(.32, .72, 0, 1)` for the seam draw and panel travel.
- `--dur-1: 120ms` press and hover; `--dur-2: 180ms` state change; `--dur-3: 260ms` surfaces.

Rules:

- Every control scales to `0.97` on `:active` in 100ms and returns in 120ms. Nothing responds only on
  release.
- The seam draws left to right with `clip-path: inset(0 100% 0 0)` → `inset(0)` over 260ms, then its
  label fades in 60ms later. It is a transition under `@starting-style`, not a keyframe, so a second
  save retargets it. Its label is mono sentence case, not the uppercase micro step: it carries a
  plugin id, and uppercasing an identifier misrepresents it.
- Popovers scale from their trigger: set `--popover-origin` from the trigger's rect before opening and
  use `transform-origin: var(--popover-origin)`. Modals stay centred.
- Exit is faster than enter (enter 260ms, exit 180ms).
- `prefers-reduced-motion: reduce` drops every transform and keeps opacity/colour fades at 120ms.
- Nothing that runs on a keystroke animates (the palette opens instantly).

## Layout

`240px sidebar | fluid main | right panel`. The right panel is 360px for work tabs and up to 560px for
the workshop; it is one panel with two modes, not two panels. At ≤1100px it becomes an overlay sheet;
at ≤760px the sidebar becomes a sheet behind a 44px header control. The transcript column is capped at
720px and centred, with the spine pinned to its left edge.

Breakpoints: 375 (phone), 760 (tablet), 1100 (rail becomes overlay), 1280 (rail always available),
1440 (workshop and transcript side by side).

## The source surface (v0.4)

The product now shows a repository: the checkout a thread is in, what changed in it, and the way out.
That surface extends this identity rather than sitting beside it, because a repository's state is the
substrate's own memory — the strongest case there is for the mono rule.

- **Groups, not cards.** Staged, Changes, and Untracked are three sections separated by hairlines, each
  with the micro heading and mono count the capability strip already uses. Nothing is boxed, nothing
  floats, and a row is a row: no per-file card, no rounded tile.
- **Mono holds every fact git measured.** Branch, upstream, worktree path, short SHA, status letter,
  line counts, and the ahead/behind pair. Prose is only ever a sentence about them ("The remote has
  commits this branch does not…"). A count is never written as a sentence when it can be a number.
- **The status letter is the one coloured glyph in the surface.** `+`/`A`/`?` read in `--success`,
  `D`/`U` in `--destructive`, `M` neutral. Failure stays a desaturated red hairline and a letter, never
  a fill, and the accent appears exactly once as a control: the commit button, drawn as an accent
  hairline rather than a filled button, because the sidebar's New thread is the screen's one filled
  control.
- **Truncation is a hierarchy, not an ellipsis.** A path keeps its file name and its last directory
  segment, with the parent muted; the full path is the row's `title`. Mono is what makes a clipped path
  legible, and the file name is what a person scans for.
- **The confirm is where the surface raises its voice.** Every destructive action (discard, remove a
  worktree, delete a branch, delete a thread) opens a dialog that names the paths and the count, and a
  destructive button is a hairline in the failure colour with its own verb — never a filled button, and
  never the default focus.
- **Nothing is claimed that was not read.** "Not published" instead of an invented upstream, a named
  explanation instead of a disabled control that lies about why, and a refusal that says which rail it
  hit. The surface's honesty *is* its design: a status read is the only source it has.

## The crew surface (v0.6)

A captain's crew row is where a person decides whether a worker's work is real and whether it should
land. Three things follow from the identity rather than from a dashboard convention.

- **The review is the branch, not a preview of it.** Opening a worker shows its commits as mono rows
  (`0d2c82c  Name the query in the empty state`) and its files as the source surface's rows — status
  letter, truncated path, `+`/`−` counts — each expanding to the same CodeMirror merge diff the
  Changes tab uses. Nothing here is a new component with a new look; a branch is a checkout, so it is
  drawn with the vocabulary the checkout already earned. The commit sha and the counts are mono
  because git measured them; the only prose is what the worker wrote.
- **Landing is one accent hairline, because it is the panel's primary action.** The sidebar's New
  thread is the screen's single filled control, so "Integrate into main" is an accent-coloured
  hairline with its target in the label — the person reads what will move before they press it.
  There is no confirmation dialog, because landing destroys nothing: the previous target commit is
  always an ancestor of the new one, and the branch and its worktree stay. The refusal is where the
  surface raises its voice: a conflict is a destructive hairline, a sentence, and the paths git named.
- **Landed is a fact, not a status.** A landed row gains a success-coloured micro label with the
  commit and, under the actions, one sentence naming the target, how it got there ("fast-forwarded"
  or "with a merge commit"), and where the worktree was kept. It stays after a reload because it is
  read from the captain's log.
- **Steering has two modes and they look different.** While a worker runs, one composer and two
  micro-labelled modes sit under it: `QUEUE` (accent hairline when pressed) and `INTERRUPT`. A queued
  steer shows on the row as an accent micro label plus the text, truncated with the full message in
  the title, so a person can see what they told a running worker without opening its transcript.
  Interrupt asks once, because it ends a turn: the confirm names what happens to the partial work.
- **A branch with nothing on it says so.** An empty branch is a sentence — "No commits on this branch
  yet, so there is nothing to diff and nothing to land" — and a disabled landing control whose title
  explains why. An empty diff that looks like zero work would be a lie about the worker.

## Components

- **Controls** are hairline-outlined, 28px tall, 6px radius, no shadow. Hover lifts the background one
  step, never the element. Inputs are *inset* (an inner hairline), not bordered boxes.
- **Chips** are mono micro-labels, uppercase, on `--secondary`, never pill-shaped with a fill.
- **Tool calls** in the transcript are compact rows on the spine: notch, mono tool name, one-line
  argument, and an expandable body. A tool provided by a user-authored plugin carries the accent seam
  on its notch.
- **The capability strip** sits above the composer: the tools that came from plugins, named in mono,
  plus a muted count of built-ins. A tool that just mounted springs in from the left.
- **No emoji. No icon-as-illustration.** Lucide at 14/16px, `stroke-width: 1.65`, muted by default.

## What this is not

No gradients, no glassmorphism, no glow, no second accent, no drop shadows where a hairline works, no
oversized rounded cards, no illustration, no emoji, no animation on repeated keyboard actions.
