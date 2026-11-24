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
| The single solid button per surface | `--accent-fill` | One filled control per screen, never two. |

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
| `--type-micro` | 11 / 14 | +0.06em, uppercase | 560 | Mono capability labels, seam labels, column headings |
| `--type-caption` | 12 / 16 | -0.005em | 450 | Secondary rows, timings, hints |
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
  label fades in 60ms later. It is a transition, not a keyframe, so a second save retargets it.
- Popovers scale from their trigger: set `--popover-origin` from the trigger's rect before opening and
  use `transform-origin: var(--popover-origin)`. Modals stay centred.
- Exit is faster than enter (enter 260ms, exit 180ms).
- `prefers-reduced-motion: reduce` drops every transform and keeps opacity/colour fades at 120ms.
- Nothing that runs on a keystroke animates (the palette opens instantly).

## Layout

`240px sidebar | fluid main | right panel`. The right panel is 320px for work tabs and up to 560px for
the workshop; it is one panel with two modes, not two panels. At ≤1100px it becomes an overlay sheet;
at ≤760px the sidebar becomes a sheet behind a 44px header control. The transcript column is capped at
720px and centred, with the spine pinned to its left edge.

Breakpoints: 375 (phone), 760 (tablet), 1100 (rail becomes overlay), 1280 (rail always available),
1440 (workshop and transcript side by side).

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
