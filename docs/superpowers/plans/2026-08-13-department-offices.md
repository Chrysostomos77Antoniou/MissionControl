# Department Offices + Orchestrator's Office + Status Chatter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `AgentDeck.tsx`'s loose 3-zone desk clustering with three real glass-walled department rooms, give the Orchestrator a visually distinct executive office, and add a proximity-based "status chatter" speech-bubble mechanic driven by real agent activity.

**Architecture:** Extract the two genuinely testable pieces of logic (department-to-agent mapping, chatter eligibility) into a new pure-function module (`lib/office-layout.ts`) with real unit tests. Everything else — floor/room/prop geometry, materials, the chatter bubble sprites themselves — is Three.js scene construction inside `AgentDeck.tsx`, exactly like every other piece of this file; it has no meaningful unit-test surface (there's no WebGL test environment in this repo, and asserting `scene.children.length` increased is test theater, not a real check). Those tasks are verified the same way every prior change to this file was verified this session: `tsc --noEmit`, `lint`, `build`, the existing `test` suite (regression, must stay green), and a dev-server boot + server-log check for runtime errors. Visual confirmation of the actual scene is not reliably available this session (the Browser pane has failed to composite frames on every attempt) — flag this to the user at the end.

**Tech Stack:** Next.js 16 (Turbopack), TypeScript, Three.js, Vitest.

## Global Constraints

- Floor grows to 48×34 (`FLOOR_W = 48`, `FLOOR_D = 34` — the depth grew from the spec's original ~32 estimate; the extra 2 units were needed to fit the department column without overlapping the conference room once exact coordinates were worked out).
- Room walls are full-height, fully enclosed glass boxes (`GlassMat()`), matching the existing conference room exactly — no doorway gaps, no new collision system. Agents already walk through the conference room's glass walls today (no collision detection anywhere in this file); department rooms follow the same precedent.
- No fabricated chatter dialogue — bubbles only ever show real `TOOL_VISUAL` label text for an agent that is genuinely `working`.
- Every task's TypeScript changes must pass `npx tsc --noEmit` and `npm run lint` with zero *new* errors (the repo has 4 known pre-existing, unrelated lint errors in `TopMenu.tsx` and `ChatPanel.tsx` — do not try to fix those, just confirm the count doesn't grow).
- `npm test` (Vitest) must stay green throughout — it currently has 7 passing tests across 2 files; this plan adds a 3rd test file and should end with more passing tests, never fewer.

---

### Task 1: Department layout data + chatter-eligibility logic (pure functions, real unit tests)

**Files:**
- Create: `lib/office-layout.ts`
- Test: `lib/__tests__/office-layout.test.ts`

**Interfaces:**
- Consumes: `AGENTS` and `AgentSpec` from `agents/registry.ts`, `AgentId` from `lib/types.ts` (all already exist).
- Produces (used by Task 2-5): `type DepartmentId = "engineering" | "growth-design" | "trust-legal"`, `AGENT_DEPARTMENT: Record<AgentId, DepartmentId>`, `DEPARTMENT_META: Record<DepartmentId, DepartmentMeta>` (with `DepartmentMeta = { name: string; center: { x: number; z: number }; size: { w: number; d: number }; cols: number; spacing: number }`), `departmentAgents(department: DepartmentId): AgentSpec[]`, `shouldChatter(opts: ChatterCheckOptions): boolean` (with `ChatterCheckOptions = { distanceSq: number; aWorking: boolean; bWorking: boolean; aCooldownUntil: number; bCooldownUntil: number; now: number }`), `CHATTER_RANGE_SQ: number` (the squared proximity threshold, exported so `AgentDeck.tsx` and the test file share the same constant).

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/office-layout.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { AGENTS } from "../../agents/registry";
import {
  AGENT_DEPARTMENT,
  CHATTER_RANGE_SQ,
  DEPARTMENT_META,
  departmentAgents,
  shouldChatter,
} from "../office-layout";

describe("AGENT_DEPARTMENT", () => {
  it("assigns exactly one department to every agent in the registry", () => {
    for (const spec of AGENTS) {
      expect(AGENT_DEPARTMENT[spec.id]).toBeDefined();
      expect(Object.keys(DEPARTMENT_META)).toContain(AGENT_DEPARTMENT[spec.id]);
    }
  });

  it("has no agent assigned to more than one department", () => {
    // Record type already prevents this structurally, but assert the id set
    // is exactly AGENTS' ids with no extras/omissions.
    const mapped = Object.keys(AGENT_DEPARTMENT).sort();
    const real = AGENTS.map((a) => a.id).sort();
    expect(mapped).toEqual(real);
  });
});

describe("departmentAgents", () => {
  it("returns every agent whose AGENT_DEPARTMENT matches, and only those", () => {
    const engineering = departmentAgents("engineering");
    for (const spec of engineering) {
      expect(AGENT_DEPARTMENT[spec.id]).toBe("engineering");
    }
    const engineeringIds = new Set(engineering.map((a) => a.id));
    for (const spec of AGENTS) {
      if (AGENT_DEPARTMENT[spec.id] === "engineering") {
        expect(engineeringIds.has(spec.id)).toBe(true);
      }
    }
  });

  it("covers all three departments across all agents with no one left out", () => {
    const total =
      departmentAgents("engineering").length +
      departmentAgents("growth-design").length +
      departmentAgents("trust-legal").length;
    expect(total).toBe(AGENTS.length);
  });
});

describe("shouldChatter", () => {
  const now = 100_000;

  it("is true when within range, one agent working, neither on cooldown", () => {
    expect(
      shouldChatter({
        distanceSq: CHATTER_RANGE_SQ - 0.01,
        aWorking: true,
        bWorking: false,
        aCooldownUntil: 0,
        bCooldownUntil: 0,
        now,
      }),
    ).toBe(true);
  });

  it("is false when outside range even if both working", () => {
    expect(
      shouldChatter({
        distanceSq: CHATTER_RANGE_SQ + 0.01,
        aWorking: true,
        bWorking: true,
        aCooldownUntil: 0,
        bCooldownUntil: 0,
        now,
      }),
    ).toBe(false);
  });

  it("is false when neither agent is working", () => {
    expect(
      shouldChatter({
        distanceSq: 0,
        aWorking: false,
        bWorking: false,
        aCooldownUntil: 0,
        bCooldownUntil: 0,
        now,
      }),
    ).toBe(false);
  });

  it("is false when the working agent is still on cooldown", () => {
    expect(
      shouldChatter({
        distanceSq: 0,
        aWorking: true,
        bWorking: false,
        aCooldownUntil: now + 5000,
        bCooldownUntil: 0,
        now,
      }),
    ).toBe(false);
  });

  it("is true when the working agent's cooldown has just expired", () => {
    expect(
      shouldChatter({
        distanceSq: 0,
        aWorking: true,
        bWorking: false,
        aCooldownUntil: now - 1,
        bCooldownUntil: 0,
        now,
      }),
    ).toBe(true);
  });

  it("is false exactly at the range boundary (strictly less-than)", () => {
    expect(
      shouldChatter({
        distanceSq: CHATTER_RANGE_SQ,
        aWorking: true,
        bWorking: false,
        aCooldownUntil: 0,
        bCooldownUntil: 0,
        now,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- office-layout`
Expected: FAIL — `Cannot find module '../office-layout'` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `lib/office-layout.ts`:

```typescript
import { AGENTS, type AgentSpec } from "../agents/registry";
import type { AgentId } from "./types";

export type DepartmentId = "engineering" | "growth-design" | "trust-legal";

export interface DepartmentMeta {
  name: string;
  center: { x: number; z: number };
  size: { w: number; d: number };
  cols: number;
  spacing: number;
}

// Grouped by how the agents' actual work relates, not the old loose
// command/arrivals/workspace zones. Every AgentId must appear exactly
// once — see office-layout.test.ts's coverage check.
export const AGENT_DEPARTMENT: Record<AgentId, DepartmentId> = {
  cybersecurity: "engineering",
  devops: "engineering",
  engineering: "engineering",
  developer: "engineering",
  qa: "engineering",
  uxdesign: "growth-design",
  marketing: "growth-design",
  growth: "growth-design",
  competitive: "growth-design",
  copywriter: "growth-design",
  community: "trust-legal",
  legal: "trust-legal",
};

// Coordinates worked out by hand to fit a 48x34 floor (x: -24..24,
// z: -17..17) with zero room overlap — see the plan's Task 2 for the
// full derivation. All three department rooms share the west column
// (x center -15, width 10) stacked along z with 1-unit walking gaps.
export const DEPARTMENT_META: Record<DepartmentId, DepartmentMeta> = {
  "trust-legal": { name: "TRUST & LEGAL", center: { x: -15, z: -12 }, size: { w: 10, d: 6 }, cols: 2, spacing: 2.5 },
  engineering: { name: "ENGINEERING", center: { x: -15, z: -3 }, size: { w: 10, d: 9 }, cols: 3, spacing: 2.5 },
  "growth-design": { name: "GROWTH & DESIGN", center: { x: -15, z: 7 }, size: { w: 10, d: 9 }, cols: 3, spacing: 2.5 },
};

export function departmentAgents(department: DepartmentId): AgentSpec[] {
  return AGENTS.filter((spec) => AGENT_DEPARTMENT[spec.id] === department);
}

// Squared distance (avoids a sqrt per pair per frame across 66 agent
// pairs) — 2 units, per the design spec's "roughly 2 units" proximity
// range for the chatter mechanic.
export const CHATTER_RANGE_SQ = 2 * 2;

export interface ChatterCheckOptions {
  distanceSq: number;
  aWorking: boolean;
  bWorking: boolean;
  aCooldownUntil: number;
  bCooldownUntil: number;
  now: number;
}

// A bubble is eligible when the pair is within range, at least one of them
// is doing real work (so there's something true to show), and that
// working agent isn't still cooling down from its last bubble. Never
// invents dialogue for two idle agents standing near each other.
export function shouldChatter(opts: ChatterCheckOptions): boolean {
  if (opts.distanceSq >= CHATTER_RANGE_SQ) return false;
  const aEligible = opts.aWorking && opts.aCooldownUntil <= opts.now;
  const bEligible = opts.bWorking && opts.bCooldownUntil <= opts.now;
  return aEligible || bEligible;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- office-layout`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Run the full verification pass**

```bash
npx tsc --noEmit
npm run lint
npm test
```

Expected: `tsc` exits 0, lint shows only the 4 known pre-existing errors, `npm test` shows 3 files / 15 tests passing (7 existing + 8 new).

- [ ] **Step 6: Commit**

```bash
git add lib/office-layout.ts lib/__tests__/office-layout.test.ts
git commit -m "Add department layout data and chatter-eligibility logic with tests"
```

---

### Task 2: Expand the floor and build the three department rooms

**Files:**
- Modify: `app/components/AgentDeck.tsx`

**Interfaces:**
- Consumes: `AGENT_DEPARTMENT`, `DEPARTMENT_META`, `departmentAgents`, `DepartmentId` from `lib/office-layout.ts` (Task 1).
- Produces: a `buildDepartmentRoom(meta: DepartmentMeta)` helper other tasks don't call directly (Task 3 adds theming props positioned relative to the same `DEPARTMENT_META` centers).

- [ ] **Step 1: Remove the old zone system and floor constants**

In `app/components/AgentDeck.tsx`, find and delete this block (lines 28-43):

```typescript
type Zone = "command" | "arrivals" | "workspace";

const AGENT_ZONE: Record<AgentId, Zone> = {
  cybersecurity: "command",
  devops: "command",
  community: "arrivals",
  engineering: "workspace",
  developer: "workspace",
  qa: "workspace",
  uxdesign: "workspace",
  marketing: "workspace",
  growth: "workspace",
  competitive: "workspace",
  copywriter: "workspace",
  legal: "workspace",
};

// Floor is 34x26 — the reference's 26x20 scaled ~1.3x to fit 12 desks
// instead of 8, same ~1.3:1 aspect ratio.
const FLOOR_W = 34;
const FLOOR_D = 26;
```

Replace it with:

```typescript
// Floor grows to fit three real department rooms (see lib/office-layout.ts)
// plus the shared common area, conference room, and the Orchestrator's
// office, none of which overlap — coordinates hand-derived in the
// 2026-08-13 department-offices plan.
const FLOOR_W = 48;
const FLOOR_D = 34;
```

- [ ] **Step 2: Import the department layout module**

Find this import block near the top of the file:

```typescript
import { AGENTS, type AgentSpec } from "../../agents/registry";
import type { AgentId } from "../../lib/types";
```

Add directly below it. Note `AGENT_DEPARTMENT` itself is deliberately **not** imported here — nothing in `AgentDeck.tsx` reads it directly, only `departmentAgents()` (defined in `office-layout.ts`, which uses `AGENT_DEPARTMENT` internally) — importing it anyway would be an unused import that `eslint` would flag:

```typescript
import { DEPARTMENT_META, departmentAgents, type DepartmentId } from "../../lib/office-layout";
```

- [ ] **Step 3: Reposition the landmark that's now inside the Engineering room**

Find (in the `LANDMARKS` array):

```typescript
const LANDMARKS: THREE.Vector3[] = [
  new THREE.Vector3(4, 0, 8), // water cooler
  new THREE.Vector3(4, 0, -8), // lounge (couch below)
  new THREE.Vector3(-13, 0, 2), // center/window
];
```

Replace the third entry (the old position sits inside the new Engineering room's footprint, x:[-20,-10] z:[-7.5,1.5]) — move it to the open walkway between the department column and the east side:

```typescript
const LANDMARKS: THREE.Vector3[] = [
  new THREE.Vector3(4, 0, 8), // water cooler
  new THREE.Vector3(4, 0, -8), // lounge (couch below)
  new THREE.Vector3(-3, 0, 0), // center/window — walkway between departments and the east side
];
```

- [ ] **Step 4: Nudge the reception desk clear of the (larger, Task 4) Orchestrator's office**

Find:

```typescript
const RECEPTION = new THREE.Vector3(10.5, 0, 8.5);
```

Replace with:

```typescript
// Nudged 2 units west of its old x=10.5 so the enlarged Orchestrator's
// office (Task 4, x: 10.5..21.5) has clearance from it.
const RECEPTION = new THREE.Vector3(8.5, 0, 8.5);
```

- [ ] **Step 5: Add a reusable department-room builder**

Find the existing conference-room wall-building code (it starts with `// ---- Conference room: glass partitions, table, 6 chairs ----`). Directly **above** that comment, insert a new helper function:

```typescript
    // ---- Department rooms: same fully-enclosed glass-box pattern as the
    // conference room below (4 full walls, no doorway gap — agents have
    // no collision detection anywhere in this file, so they already walk
    // straight through the conference room's glass today; department
    // rooms follow the same precedent rather than inventing new
    // wall-collision/doorway logic). ----
    function buildDepartmentRoom(meta: (typeof DEPARTMENT_META)[DepartmentId]) {
      const hw = meta.size.w / 2;
      const hd = meta.size.d / 2;
      ([
        [meta.size.w, 0.06, meta.center.x, meta.center.z - hd],
        [meta.size.w, 0.06, meta.center.x, meta.center.z + hd],
      ] as const).forEach(([w, d, x, z]) => {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 3.5, d), glass);
        wall.position.set(x, 1.75, z);
        scene.add(wall);
      });
      ([
        [0.06, meta.size.d, meta.center.x - hw, meta.center.z],
        [0.06, meta.size.d, meta.center.x + hw, meta.center.z],
      ] as const).forEach(([w, d, x, z]) => {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 3.5, d), glass);
        wall.position.set(x, 1.75, z);
        scene.add(wall);
      });
      const label = makeLabelSprite(meta.name, "#38bdf8");
      label.position.set(meta.center.x, 4.3, meta.center.z);
      scene.add(label);
    }

    (Object.keys(DEPARTMENT_META) as DepartmentId[]).forEach((id) => buildDepartmentRoom(DEPARTMENT_META[id]));

```

This is safe as placed: `const glass = GlassMat();` is declared earlier, in the perimeter-walls section (`const hx = FLOOR_W / 2; const hz = FLOOR_D / 2; const glass = GlassMat();`), well before the conference-room comment — inserting `buildDepartmentRoom` directly above that comment guarantees `glass` is already in scope.

- [ ] **Step 6: Replace the old zone-based desk loop with the department-based one**

Find (the `zoneCenters` block and its usage — search for `zoneCenters`):

```typescript
    const zoneCenters: Record<Zone, { cx: number; cz: number; cols: number; spacing: number }> = {
      command: { cx: -9, cz: -6, cols: 2, spacing: 2.8 },
      arrivals: { cx: -9, cz: 6.5, cols: 1, spacing: 2.8 },
      workspace: { cx: -4, cz: 2, cols: 3, spacing: 2.6 },
    };
```

and its sibling `byZone` grouping code just above it:

```typescript
    const byZone = new Map<Zone, AgentSpec[]>();
    for (const spec of AGENTS) {
      const z = AGENT_ZONE[spec.id];
      (byZone.get(z) ?? byZone.set(z, []).get(z)!).push(spec);
    }
```

Delete both. Also find the loop that consumes them near the bottom of the setup code:

```typescript
    for (const [zone, specs] of byZone) {
      const { cx, cz, cols, spacing } = zoneCenters[zone];
      const positions = deskPositions(specs.length, cols, cx, cz, spacing);
      specs.forEach((spec, i) => buildAgent(spec, positions[i]));
    }
```

Replace it with:

```typescript
    (Object.keys(DEPARTMENT_META) as DepartmentId[]).forEach((id) => {
      const meta = DEPARTMENT_META[id];
      const specs = departmentAgents(id);
      const positions = deskPositions(specs.length, meta.cols, meta.center.x, meta.center.z, meta.spacing);
      specs.forEach((spec, i) => buildAgent(spec, positions[i]));
    });
```

Note this loop must stay **after** `buildAgent` is defined (it already was, in the same relative position as the code it replaces) and after Step 5's `buildDepartmentRoom` calls (rooms should render before desks are placed inside them, though Three.js doesn't actually care about add-order for rendering — this is just for readability).

- [ ] **Step 7: Remove the now-unused `AgentId` import if it becomes unused**

`AgentId` is still used elsewhere in this file (the `AgentRig`/props types), so no import cleanup is needed here — just confirm by running `tsc` in the next step rather than guessing.

- [ ] **Step 8: Verify**

```bash
npx tsc --noEmit
npm run lint
npm run build
npm test
```

Expected: `tsc` exits 0 (this is the step that will catch it if `Zone`/`AGENT_ZONE`/`zoneCenters`/`byZone` are still referenced anywhere they shouldn't be), lint unchanged (4 known errors only), build succeeds, tests still 15/15 passing (this task touches no test files).

- [ ] **Step 9: Commit**

```bash
git add app/components/AgentDeck.tsx
git commit -m "Replace loose desk zones with three real department rooms"
```

---

### Task 3: Department theming props + relocate the bookshelf

**Files:**
- Modify: `app/components/AgentDeck.tsx`

**Interfaces:**
- Consumes: `DEPARTMENT_META` from Task 1 (for positioning props relative to each room's `center`).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Move the bookshelf into the Trust & Legal room and add a filing cabinet**

Find the existing bookshelf block:

```typescript
    // ---- Bookshelf, plants, sticky notes, lounge couch, floating particles ----
    const shelfFrame = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.4, 0.4), Lam(0xd8dde6));
    shelfFrame.position.set(SHELF_POS.x, 0.7, SHELF_POS.z);
    scene.add(shelfFrame);
    [0xef4444, 0xf97316, 0xeab308, 0x22c55e, 0x3b82f6, 0xa855f7, 0xec4899].forEach((c, i) => {
      const book = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.32), Lam(c));
      book.position.set(SHELF_POS.x - 0.5 + i * 0.16, 1.06, SHELF_POS.z);
      scene.add(book);
    });
```

Find the `SHELF_POS` constant declaration near the top of the file:

```typescript
const SHELF_POS = new THREE.Vector3(-15, 0, -10);
```

Replace it with a position inside the Trust & Legal room (center `{-15, -12}`, size `10x6` → interior x:[-20,-10], z:[-15,-9]) — place it against the room's west wall:

```typescript
const SHELF_POS = new THREE.Vector3(-19, 0, -13);
const FILING_CABINET_POS = new THREE.Vector3(-11, 0, -13);
```

Directly after the existing book-loop block (still inside the same `// ---- Bookshelf...` section), add the filing cabinet:

```typescript
    const cabinet = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.5), Lam(0x5a6472));
    cabinet.position.set(FILING_CABINET_POS.x, 0.55, FILING_CABINET_POS.z);
    cabinet.castShadow = true;
    scene.add(cabinet);
    const cabinetHandle = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.03), Basic(0xaabbcc));
    cabinetHandle.position.set(FILING_CABINET_POS.x, 0.7, FILING_CABINET_POS.z + 0.26);
    scene.add(cabinetHandle);
```

- [ ] **Step 2: Add the Engineering server rack**

In the same general area of the file (directly after the filing cabinet code from Step 1 is a fine spot), add:

```typescript
    // Engineering room theme prop: a small server rack in the room's
    // west corner (center {-15,-3}, size 10x9 -> interior x:[-20,-10]).
    const rackCenter = { x: -19, z: -6.5 };
    const rack = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.6, 0.6), Lam(0x1f2937));
    rack.position.set(rackCenter.x, 0.8, rackCenter.z);
    rack.castShadow = true;
    scene.add(rack);
    [0x22c55e, 0x3b82f6, 0xef4444].forEach((c, i) => {
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.03), Basic(c));
      led.position.set(rackCenter.x, 0.3 + i * 0.4, rackCenter.z + 0.31);
      scene.add(led);
    });
```

- [ ] **Step 3: Add the Growth & Design mood board**

Directly after the server rack code, add:

```typescript
    // Growth & Design room theme prop: a freestanding mood-board panel
    // on a simple stand, standing in the room's west corner (center
    // {-15,7}, size 10x9 -> interior x:[-20,-10]).
    const boardCenter = { x: -19, z: 4.5 };
    const boardStandL = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.2, 0.04), Lam(0x8a93a8));
    boardStandL.position.set(boardCenter.x - 0.6, 0.6, boardCenter.z);
    scene.add(boardStandL);
    const boardStandR = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.2, 0.04), Lam(0x8a93a8));
    boardStandR.position.set(boardCenter.x + 0.6, 0.6, boardCenter.z);
    scene.add(boardStandR);
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.9, 0.04), Lam(0xf5f7fa));
    board.position.set(boardCenter.x, 1.05, boardCenter.z);
    board.castShadow = true;
    scene.add(board);
    [0xec4899, 0x38bdf8, 0xfacc15].forEach((c, i) => {
      const swatch = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.14, 0.01), Basic(c));
      swatch.position.set(boardCenter.x - 0.4 + i * 0.4, 1.15, boardCenter.z + 0.025);
      scene.add(swatch);
    });
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
npm run lint
npm run build
npm test
```

Expected: same as Task 2's verification — `tsc` clean, lint unchanged, build succeeds, 15/15 tests passing.

- [ ] **Step 5: Commit**

```bash
git add app/components/AgentDeck.tsx
git commit -m "Add per-department theme props, relocate bookshelf into Trust & Legal"
```

---

### Task 4: The Orchestrator's executive office

**Files:**
- Modify: `app/components/AgentDeck.tsx`

**Interfaces:**
- Consumes: `glass` material variable and `makeLabelSprite` (already in scope from earlier in the file).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Reposition and enlarge the Orchestrator's desk area**

Find:

```typescript
const ORCH_DESK = new THREE.Vector3(-9, 0, 10);
```

Replace with:

```typescript
// The largest room in the building (11x10, vs. 10x9 for the department
// rooms and 7.5x7.2 for the conference room) and positioned prominently
// near the entrance/reception rather than tucked in a corner.
const ORCH_DESK = new THREE.Vector3(16, 0, 5);
const ORCH_ROOM = { w: 11, d: 10 };
```

- [ ] **Step 2: Replace the existing Orchestrator desk block with the executive-office version**

Find the entire existing block:

```typescript
    // ---- Orchestrator's desk — distinct standalone desk, click opens the Orchestrator chat ----
    const orchDesk = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 1.0), Lam(0x241a33));
    orchDesk.position.set(ORCH_DESK.x, 0.45, ORCH_DESK.z);
    orchDesk.castShadow = true;
    scene.add(orchDesk);
    const orchNamebar = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.06, 0.08), Basic(0xffae3b));
    orchNamebar.position.set(ORCH_DESK.x, 0.94, ORCH_DESK.z + 0.52);
    scene.add(orchNamebar);
    const orchLabel = makeLabelSprite("ORCHESTRATOR", "#ffae3b");
    orchLabel.position.set(ORCH_DESK.x, 1.75, ORCH_DESK.z);
    scene.add(orchLabel);
    (orchDesk.userData as { orchestrator: boolean }).orchestrator = true;
    (orchLabel.userData as { orchestrator: boolean }).orchestrator = true;
    raycastTargets.push(orchDesk, orchLabel);
```

Replace it with:

```typescript
    // ---- Orchestrator's office: the executive treatment. Same fully-
    // enclosed glass-box room pattern as buildDepartmentRoom/the
    // conference room, plus a raised dais, a bigger/glossier desk, an
    // executive chair, warm amber lighting (matching the amber already
    // used for "Orchestrator" throughout the app's chat UI), and a
    // larger gold-framed sign. ----
    ([
      [ORCH_ROOM.w, 0.06, ORCH_DESK.x, ORCH_DESK.z - ORCH_ROOM.d / 2],
      [ORCH_ROOM.w, 0.06, ORCH_DESK.x, ORCH_DESK.z + ORCH_ROOM.d / 2],
    ] as const).forEach(([w, d, x, z]) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 3.5, d), glass);
      wall.position.set(x, 1.75, z);
      scene.add(wall);
    });
    ([
      [0.06, ORCH_ROOM.d, ORCH_DESK.x - ORCH_ROOM.w / 2, ORCH_DESK.z],
      [0.06, ORCH_ROOM.d, ORCH_DESK.x + ORCH_ROOM.w / 2, ORCH_DESK.z],
    ] as const).forEach(([w, d, x, z]) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 3.5, d), glass);
      wall.position.set(x, 1.75, z);
      scene.add(wall);
    });

    // Dais: a low riser under the desk, ~0.15 units tall (for scale,
    // chair seats sit at 0.44 and desk tops at ~0.73-0.9 elsewhere).
    const dais = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.15, 2.4), Lam(0x2a2f3a));
    dais.position.set(ORCH_DESK.x, 0.075, ORCH_DESK.z);
    dais.receiveShadow = true;
    scene.add(dais);

    // Executive desk: bigger footprint than any department desk, glossy
    // dark-wood-toned top instead of the flat color the old desk had.
    const orchDesk = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.9, 1.3), Lam(0x3b2a1a));
    orchDesk.position.set(ORCH_DESK.x, 0.15 + 0.45, ORCH_DESK.z);
    orchDesk.castShadow = true;
    scene.add(orchDesk);
    const orchDeskTop = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.05, 1.4), Lam(0x5a3d24, { emissive: 0x1a0f08, emissiveIntensity: 0.15 }));
    orchDeskTop.position.set(ORCH_DESK.x, 0.15 + 0.925, ORCH_DESK.z);
    scene.add(orchDeskTop);

    // Executive chair: taller high-backed silhouette, distinct from the
    // plain stool every other agent sits on.
    const chairSeat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 0.55), Lam(0x241a33));
    chairSeat.position.set(ORCH_DESK.x, 0.15 + 0.5, ORCH_DESK.z + 0.85);
    scene.add(chairSeat);
    const chairBack = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.85, 0.06), Lam(0x241a33));
    chairBack.position.set(ORCH_DESK.x, 0.15 + 0.9, ORCH_DESK.z + 1.1);
    scene.add(chairBack);

    // Warm amber lighting specific to this office — stands out against
    // the cooler general office lighting, matches the app's own
    // "Orchestrator" amber branding.
    const orchLight1 = new THREE.PointLight(0xffae3b, 0.9, 6, 2);
    orchLight1.position.set(ORCH_DESK.x - 2, 3, ORCH_DESK.z);
    scene.add(orchLight1);
    const orchLight2 = new THREE.PointLight(0xffae3b, 0.9, 6, 2);
    orchLight2.position.set(ORCH_DESK.x + 2, 3, ORCH_DESK.z);
    scene.add(orchLight2);

    const orchNamebar = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.08, 0.1), Basic(0xffae3b));
    orchNamebar.position.set(ORCH_DESK.x, 0.15 + 0.98, ORCH_DESK.z + 0.68);
    scene.add(orchNamebar);

    // Bigger, gold-framed sign — noticeably larger than department room
    // labels (worldW 2.5) and every desk nameplate (worldW 2.5).
    const orchLabel = makeLabelSprite("ORCHESTRATOR", "#ffae3b");
    orchLabel.scale.multiplyScalar(1.6);
    orchLabel.position.set(ORCH_DESK.x, 4.6, ORCH_DESK.z);
    scene.add(orchLabel);

    (orchDesk.userData as { orchestrator: boolean }).orchestrator = true;
    (orchLabel.userData as { orchestrator: boolean }).orchestrator = true;
    raycastTargets.push(orchDesk, orchLabel);
```

Note: `orchDesk` and `orchLabel` variable names are unchanged from the original, so anything later in the file referencing them (there shouldn't be anything else, but `tsc` will catch it in Step 3 if there is) keeps working.

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npm run lint
npm run build
npm test
```

Expected: `tsc` clean, lint unchanged, build succeeds, 15/15 tests passing.

- [ ] **Step 4: Commit**

```bash
git add app/components/AgentDeck.tsx
git commit -m "Give the Orchestrator an executive office: dais, bigger desk/chair, amber lighting, bigger sign"
```

---

### Task 5: Status chatter — proximity speech bubbles

**Files:**
- Modify: `app/components/AgentDeck.tsx`

**Interfaces:**
- Consumes: `shouldChatter` and `CHATTER_RANGE_SQ` from `lib/office-layout.ts` (Task 1); `TOOL_VISUAL`/`DEFAULT_TOOL_VISUAL` (already imported in this file).
- Produces: nothing consumed by later tasks (this is the last task before final verification).

- [ ] **Step 1: Import `shouldChatter` and `CHATTER_RANGE_SQ`**

Find the import added in Task 2, Step 2:

```typescript
import { DEPARTMENT_META, departmentAgents, type DepartmentId } from "../../lib/office-layout";
```

Replace with:

```typescript
import {
  CHATTER_RANGE_SQ,
  DEPARTMENT_META,
  departmentAgents,
  shouldChatter,
  type DepartmentId,
} from "../../lib/office-layout";
```

- [ ] **Step 2: Add a chatter-bubble sprite helper**

Find `makeLabelSprite` (search for `function makeLabelSprite`). Directly after that whole function, add:

```typescript
// Small transient speech-bubble sprite for the status-chatter mechanic —
// visually distinct from makeLabelSprite's nameplates (light background,
// no colored outline, so it reads as "speech" not "signage").
function makeChatterBubble(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 80;
  const ctx = canvas.getContext("2d")!;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let fontSize = 28;
  const maxTextWidth = canvas.width - 32;
  while (fontSize > 14) {
    ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
    if (ctx.measureText(text).width <= maxTextWidth) break;
    fontSize -= 2;
  }
  const textWidth = ctx.measureText(text).width;
  const boxW = Math.min(canvas.width - 4, textWidth + 28);
  const boxH = fontSize + 22;
  const boxX = canvas.width / 2 - boxW / 2;
  const boxY = canvas.height / 2 - boxH / 2;
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, 10);
  ctx.fill();
  ctx.fillStyle = "#111318";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  const worldW = 1.6;
  sprite.scale.set(worldW, worldW * (canvas.height / canvas.width), 1);
  return sprite;
}
```

- [ ] **Step 3: Add chatter state to `AgentRig`**

Find the `AgentRig` interface (search for `interface AgentRig`). It currently ends with:

```typescript
  wasWorking: boolean;
  inMeeting: boolean;
  nextWanderAt: number;
}
```

Replace with:

```typescript
  wasWorking: boolean;
  inMeeting: boolean;
  nextWanderAt: number;
  chatterCooldownUntil: number;
  chatterSprite: THREE.Sprite | null;
  chatterUntil: number;
}
```

Find where `rigs.set(spec.id, { ... })` is called inside `buildAgent` (search for `rigs.set(spec.id`). It currently ends with:

```typescript
        wasWorking: false,
        inMeeting: false,
        nextWanderAt: performance.now() + 1500 + Math.random() * 3000,
      });
```

Replace with:

```typescript
        wasWorking: false,
        inMeeting: false,
        nextWanderAt: performance.now() + 1500 + Math.random() * 3000,
        chatterCooldownUntil: 0,
        chatterSprite: null,
        chatterUntil: 0,
      });
```

- [ ] **Step 4: Run the pairwise chatter check in the tick loop**

Find the end of the main per-agent `for (const [id, r] of rigs) { ... }` loop inside `tick(now)` — it's the loop containing the `if (working) { ... } else { ... }` monitor-glow block, and it closes with a `}` immediately followed by `controls.update();`. Find this exact tail:

```typescript
        if (working) {
          const visual = (info?.tool && TOOL_VISUAL[info.tool]) || DEFAULT_TOOL_VISUAL;
          r.monitorMat.emissive.setHex(visual.color);
          r.monitorMat.emissiveIntensity = cyberpunkRef.current ? 2.0 : 1.0;
          r.deskLight.intensity = cyberpunkRef.current ? 1.3 : 0.65;
          r.deskLight.color.setHex(visual.color);
        } else {
          r.monitorMat.emissiveIntensity = cyberpunkRef.current ? 0.45 : 0.15;
          r.deskLight.intensity = cyberpunkRef.current ? 0.22 : 0;
        }
      }

      controls.update();
      renderer.render(scene, camera);
```

Replace it with (the per-agent loop's closing `}` is unchanged; new code is inserted between it and `controls.update()`):

```typescript
        if (working) {
          const visual = (info?.tool && TOOL_VISUAL[info.tool]) || DEFAULT_TOOL_VISUAL;
          r.monitorMat.emissive.setHex(visual.color);
          r.monitorMat.emissiveIntensity = cyberpunkRef.current ? 2.0 : 1.0;
          r.deskLight.intensity = cyberpunkRef.current ? 1.3 : 0.65;
          r.deskLight.color.setHex(visual.color);
        } else {
          r.monitorMat.emissiveIntensity = cyberpunkRef.current ? 0.45 : 0.15;
          r.deskLight.intensity = cyberpunkRef.current ? 0.22 : 0;
        }

        // Remove this agent's chatter bubble once its display window ends.
        if (r.chatterSprite && now > r.chatterUntil) {
          scene.remove(r.chatterSprite);
          r.chatterSprite = null;
        }
      }

      // Status chatter: pairwise proximity check across all agents. Skips
      // pairs where BOTH are seated (two desk-neighbors sitting near each
      // other isn't an "encounter" — this only fires when at least one of
      // them is actually out walking, most commonly a wandering agent
      // passing a working, seated colleague's desk). O(n^2) over 12
      // agents is 66 pairs, trivial.
      const rigList = Array.from(rigs.entries());
      for (let i = 0; i < rigList.length; i++) {
        for (let j = i + 1; j < rigList.length; j++) {
          const [aId, a] = rigList[i];
          const [bId, b] = rigList[j];
          if (a.seated && b.seated) continue;
          if (a.chatterSprite || b.chatterSprite) continue;
          const distanceSq = a.group.position.distanceToSquared(b.group.position);
          if (distanceSq >= CHATTER_RANGE_SQ) continue;
          const aWorking = (latestRef.current.statuses[aId]?.live ?? "idle") === "working";
          const bWorking = (latestRef.current.statuses[bId]?.live ?? "idle") === "working";
          const eligible = shouldChatter({
            distanceSq,
            aWorking,
            bWorking,
            aCooldownUntil: a.chatterCooldownUntil,
            bCooldownUntil: b.chatterCooldownUntil,
            now,
          });
          if (!eligible) continue;
          const speaker = aWorking && a.chatterCooldownUntil <= now ? a : b;
          const speakerId = speaker === a ? aId : bId;
          const info = latestRef.current.statuses[speakerId];
          const visual = (info?.tool && TOOL_VISUAL[info.tool]) || DEFAULT_TOOL_VISUAL;
          const bubble = makeChatterBubble(visual.label);
          bubble.position.set(speaker.group.position.x, 2.1, speaker.group.position.z);
          scene.add(bubble);
          speaker.chatterSprite = bubble;
          speaker.chatterUntil = now + 3000;
          speaker.chatterCooldownUntil = now + 20000 + Math.random() * 10000;
        }
      }

      controls.update();
      renderer.render(scene, camera);
```

- [ ] **Step 5: Dispose chatter sprites on unmount**

Find the cleanup `return () => { ... }` at the end of the `useEffect`. It currently ends with:

```typescript
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
      rigs.clear();
    };
```

Replace with:

```typescript
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
      for (const r of rigs.values()) {
        if (r.chatterSprite) scene.remove(r.chatterSprite);
      }
      rigs.clear();
    };
```

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit
npm run lint
npm run build
npm test
```

Expected: `tsc` clean (this will catch it if `rigs` isn't in scope at the cleanup site under the new reference, or if any chatter field is missed on `rigs.set`), lint unchanged, build succeeds, 15/15 tests passing.

- [ ] **Step 7: Commit**

```bash
git add app/components/AgentDeck.tsx
git commit -m "Add proximity-based status chatter bubbles using real tool activity"
```

---

### Task 6: Final integration pass

**Files:** none (verification only).

- [ ] **Step 1: Full verification suite**

```bash
npx tsc --noEmit
npm run lint
npm run build
npm test
```

Expected: `tsc` exits 0, lint shows exactly the 4 known pre-existing errors (no more, no fewer), build succeeds with "✓ Compiled successfully", `npm test` shows 3 test files / 15 tests passing.

- [ ] **Step 2: Boot the dev server and check for runtime errors**

Start the `mission-control-dev` preview (or `npm run dev` if not using the preview tool), load the dashboard, and check server logs / browser console for errors — particularly watch for Three.js console errors on scene construction (a bad `BoxGeometry` dimension, an out-of-scope variable, etc. that `tsc` wouldn't catch because it's a runtime-only Three.js error).

- [ ] **Step 3: Tell the user visual confirmation is still needed**

This plan cannot verify the *look* of the result — room placement, prop scale, whether the chatter bubbles read clearly, whether the Orchestrator's office actually reads as "the boss" — only that it compiles, builds, and runs without throwing. Say so plainly and ask the user to check it visually once they're able to.

- [ ] **Step 4: Final commit if any cleanup was needed**

Only if Steps 1-2 turned up something to fix — otherwise Task 5's commit is the last one and this task is a no-op beyond verification.
