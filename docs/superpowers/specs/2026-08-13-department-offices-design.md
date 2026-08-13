# Department offices + Orchestrator's office + status chatter — design

## Context

`AgentDeck.tsx` currently renders all 12 agents on a single open floor,
grouped only loosely (by desk-cluster position, not by walls) into three
zones that don't map cleanly onto how the agents actually relate to each
other's work. The Orchestrator — the one agent every other interaction in
the app routes through (chat header, the dedicated `/api/chat` endpoint,
its own desk) — currently gets the same visual treatment as every other
agent: a desk, a nameplate, and an accent color.

The owner asked for two related changes: real department rooms grouping
agents by function, and an Orchestrator office that visually reads as "the
boss" without needing to read a label to know it.

## Goals

- Replace the current loose 3-zone desk clustering with three real,
  glass-walled department rooms.
- Give the Orchestrator a distinct, unmistakably senior office.
- Add a lightweight "agents talk to each other" mechanic that stays honest
  to real data — no invented dialogue.
- Preserve everything about the scene that already works: the shared
  common area (reception/water-cooler/lounge), the conference room and its
  stand-up scheduler, the character rig, desk/monitor/chair design, and
  the HUD (header/ticker/legend).

## Non-goals

- No solid walls / hallways / doors (decided against in favor of glass
  partitions, so every agent stays visible from the main camera at all
  times — the whole point of a monitoring dashboard).
- No per-agent private offices (decided against — see prior turn in this
  conversation; grouped department rooms were the chosen middle ground).
- No fabricated conversation content in the talk mechanic.

## Building layout

Floor grows from the current 34×26 to **46×32** to fit three department
rooms plus the existing shared spaces without crowding.

Rooms (all glass-walled, matching the existing conference room's
`GlassMat()` construction — four full-height glass walls per room, fully
enclosed, each with a floating label sprite). The existing conference
room has no doorway gap either: agents have no collision detection today
(movement is a straight line to a target x/z), so they already walk
through the meeting room's transparent walls to reach their seats, and
it's not visually jarring since the material is see-through. Department
rooms follow the same established pattern rather than inventing wall
collision/doorway logic that nothing else in the file has.

| Room | Agents | Desk grid |
|---|---|---|
| Engineering | cybersecurity, devops, engineering, developer, qa | 5 desks, 2×3 |
| Growth & Design | uxdesign, marketing, growth, competitive, copywriter | 5 desks |
| Trust & Legal | community, legal | 2 desks |

`AGENT_ZONE` (currently `command`/`arrivals`/`workspace`) is replaced with
a mapping onto these three room ids, and `zoneCenters` moves each room to
its new position in the expanded floor plan.

Unchanged, repositioned as needed to fit the larger floor:
- Shared common area (reception desk, water cooler, lounge couch) — no
  walls, every agent wanders here regardless of department.
- Conference room — unchanged mechanically; the existing stand-up
  scheduler already pulls a random mix of idle agents, so it naturally
  reads as a cross-department meeting once departments exist.
- Bookshelf moves into the Trust & Legal room (thematically fits); plants
  stay scattered as general decor.

## Department theming

Each room gets 1-2 theme props so it's identifiable without reading the
label:
- **Engineering**: a small server rack prop (dark box, a few small
  emissive strips as LEDs).
- **Growth & Design**: a freestanding mood-board/whiteboard panel inside
  the room (not mounted on the glass — a standalone prop near a wall,
  same idea as the bookshelf being a standalone piece of furniture).
- **Trust & Legal**: the relocated bookshelf, plus a filing cabinet prop.

## Orchestrator's office

Promoted from a small standalone desk to the most visually distinct space
in the building:

- **Position**: the largest glass-walled room in the building, placed
  prominently near the entrance/reception — not tucked in a corner like
  the department rooms.
- **Elevation**: a low floor riser (dais) under the desk, roughly 0.15
  units tall — enough to read as "raised" from the main camera angle
  without looking like a separate floor level (for scale, chair seats
  sit at 0.44 and desk tops at ~0.73-0.9 elsewhere in the scene).
- **Desk**: larger footprint than any department desk, richer/glossier
  material (a dark wood-like tone rather than the current flat color).
- **Seating**: a distinct high-backed executive chair, geometrically
  different from the plain stool every other agent sits on.
- **Lighting**: warm amber/gold point lighting specific to this room,
  standing out against the cooler general office lighting — matches the
  amber already used for "Orchestrator" throughout the app's own chat UI
  (`accent="var(--amber)"`), so it's consistent with existing branding,
  not an arbitrary color pick.
- **Signage**: a nameplate noticeably larger than department room labels,
  with a gold frame instead of the plain outline every other label uses.

## Status chatter (the "talk to each other" mechanic)

Each tick, check pairwise distance between agents who are currently
wandering (not seated at a desk or in the meeting room). When two are
within roughly 2 units of each other **and at least one of them is
genuinely `working`**, spawn a small speech-bubble sprite above that
agent for ~3 seconds, showing text derived from their real current tool
status (the same `TOOL_VISUAL` label data that already drives the
monitor glow — e.g. "reviewing repo", "querying db"). A ~20-30 second
per-agent cooldown after a bubble prevents the same agent from spamming
bubbles back to back.

If neither nearby agent is doing real work, no bubble appears — idle
agents standing near each other stay silent rather than getting invented
small talk.

## Verification

Same discipline as every other change to this file this session:
`npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm test`, dev
server boot + server-log check. Visual confirmation is not reliably
available this session (the Browser pane has failed to composite frames
in every attempt so far) — the owner will need to eyeball the result
directly once it's built.
