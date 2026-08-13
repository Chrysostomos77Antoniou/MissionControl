"use client";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { AgentSpec } from "../../agents/registry";
import type { AgentId } from "../../lib/types";
import { DEPARTMENT_META, departmentAgents, type DepartmentId } from "../../lib/office-layout";
import type { AgentStatusInfo, AgentLive } from "../../lib/agent-status";
import { TOOL_VISUAL, DEFAULT_TOOL_VISUAL } from "../../lib/tool-visual";

// Ported directly from the real source of Gaurav2693/ai-office
// (github.com/Gaurav2693/ai-office, MIT, live at
// skill-deploy-qmm7droauc.vercel.app) — fetched and read file-by-file
// (OfficeScene.js, Header/Ticker/Legend/HUD.jsx) rather than guessed from
// screenshots. Matched: narrow-FOV perspective camera + ACES tone mapping
// (not a true orthographic camera — a narrow FOV at distance is what gives
// the near-isometric look while keeping real depth/occlusion), Lambert/
// Basic/physical-glass materials, fog, the floor+carpet+4-wall-perimeter+
// corner-mullion structure, the ceiling-slab + 5x3 light-panel grid (this,
// not a truss, is what the "black lines" in earlier screenshots actually
// were), the per-agent desk/monitor/chair part breakdown, and a two-pose
// (standing/sitting) voxel character rig with hair/collar/eyes/badge.
// Deliberately not ported: their day/night clock UI, fixed-clock meeting
// windows, and per-agent hand-drawn canvas monitor art (RONIN/SAGE/etc. are
// their branded characters) — our monitors instead show real live tool
// status, and meetings use a lightweight randomized scheduler, since there
// is no real "time of day" concept in this app.

// Floor grows to fit three real department rooms (see lib/office-layout.ts)
// plus the shared common area, conference room, and the Orchestrator's
// office, none of which overlap — coordinates hand-derived in the
// 2026-08-13 department-offices plan.
const FLOOR_W = 48;
const FLOOR_D = 34;
const SKIN = 0xdeb887;

const LANDMARKS: THREE.Vector3[] = [
  new THREE.Vector3(4, 0, 8), // water cooler
  new THREE.Vector3(4, 0, -8), // lounge (couch below)
  new THREE.Vector3(-3, 0, 0), // center/window — walkway between departments and the east side
];

const ORCH_DESK = new THREE.Vector3(-9, 0, 10);
// Nudged 2 units west of its old x=10.5 so the enlarged Orchestrator's
// office (Task 4, x: 10.5..21.5) has clearance from it.
const RECEPTION = new THREE.Vector3(8.5, 0, 8.5);
const MEETING_CENTER = new THREE.Vector3(10.5, 0, -4);
const MEETING_ROOM_W = 7.5;
const MEETING_ROOM_D = 7.2;
// Sitting characters face -Z by default (see buildCharacter's eye/hair
// placement) — so a seat south of the table (more negative z) must face
// +Z to look at it, and a seat north of it must face -Z. These were
// previously swapped, which pointed every seated agent away from the
// table instead of at it.
const MEETING_SEATS: { x: number; z: number; ry: number }[] = [-1.8, 0, 1.8].flatMap((dx) => [
  { x: MEETING_CENTER.x + dx, z: MEETING_CENTER.z - 1.45, ry: Math.PI },
  { x: MEETING_CENTER.x + dx, z: MEETING_CENTER.z + 1.45, ry: 0 },
]);
const SHELF_POS = new THREE.Vector3(-19, 0, -13);
const FILING_CABINET_POS = new THREE.Vector3(-11, 0, -13);
const PLANT_POS: THREE.Vector3[] = [
  new THREE.Vector3(-16, 0, -11),
  new THREE.Vector3(-15, 0, 10),
  new THREE.Vector3(15, 0, -11),
  new THREE.Vector3(14, 0, 12),
];
const STICKY_POS: THREE.Vector3[] = [
  new THREE.Vector3(-3, 0.01, 1),
  new THREE.Vector3(-5, 0.01, 3),
  new THREE.Vector3(-9, 0.01, -5.5),
  new THREE.Vector3(-2, 0.01, 4),
];
const HAIR_COLORS = [0x2b2b2b, 0x4a3222, 0x1a1a1a, 0x6b4423, 0x3a2a1a, 0x262626, 0x8b4513, 0x4e342e];
const FLOAT_COLORS = [0x22d3ee, 0xec4899, 0x38bdf8, 0xf472b6];

// ---- Material helpers, matching the reference's M()/MB()/Glass() ----
function Lam(color: number, extra?: Partial<THREE.MeshLambertMaterialParameters>): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, ...extra });
}
function Basic(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color });
}
function GlassMat(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({ color: 0xbbccdd, transparent: true, opacity: 0.09, roughness: 0 });
}
function shade(hex: string, factor: number): number {
  return new THREE.Color(hex).multiplyScalar(factor).getHex();
}

function deskPositions(count: number, cols: number, cx: number, cz: number, spacing: number) {
  const rows = Math.ceil(count / cols);
  const out: { x: number; z: number }[] = [];
  const w = (cols - 1) * spacing;
  const d = (rows - 1) * spacing;
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({ x: cx - w / 2 + c * spacing, z: cz - d / 2 + r * spacing });
  }
  return out;
}

function makeSignTexture(text: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#0b1220";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#e8edf5";
  ctx.font = "bold 60px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.letterSpacing = "6px";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Billboarded nameplate above a desk. Auto-shrinks font to fit so long
// ids never clip; white text in an accent outline for max contrast.
function makeLabelSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxTextWidth = canvas.width - 28;
  let fontSize = 36;
  while (fontSize > 16) {
    ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
    if (ctx.measureText(text).width <= maxTextWidth) break;
    fontSize -= 2;
  }
  const textWidth = ctx.measureText(text).width;
  const boxW = Math.min(canvas.width - 4, textWidth + 32);
  const boxH = fontSize + 24;
  const boxX = canvas.width / 2 - boxW / 2;
  const boxY = canvas.height / 2 - boxH / 2;
  ctx.fillStyle = "rgba(5,6,10,0.88)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect(boxX + 1.5, boxY + 1.5, boxW - 3, boxH - 3);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  const worldW = 2.5;
  sprite.scale.set(worldW, worldW * (canvas.height / canvas.width), 1);
  return sprite;
}

// Two-pose voxel humanoid, matching the reference's buildChar() part
// breakdown (legs/shoes/torso/collar/arms/head/hair/eyes/badge), built
// once per agent per pose and toggled via visibility rather than
// reconstructed — standing "front" is +Z (walking), sitting "front" is
// -Z (facing the monitor), matching the reference's own convention.
function buildCharacter(standing: boolean, shirt: number, pants: number, hair: number, badgeColor: number): THREE.Group {
  const g = new THREE.Group();
  if (standing) {
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4, 0.1), Lam(pants));
    legL.position.set(-0.08, 0.2, 0);
    legL.userData.phase = 0;
    const legR = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4, 0.1), Lam(pants));
    legR.position.set(0.08, 0.2, 0);
    legR.userData.phase = Math.PI;
    g.add(legL, legR);
    g.userData.legs = [legL, legR];
    [-1, 1].forEach((s) => {
      const sh = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.05, 0.16), Lam(0x222222));
      sh.position.set(s * 0.08, 0.025, 0);
      g.add(sh);
    });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.3, 0.16), Lam(shirt));
    torso.position.set(0, 0.58, 0);
    g.add(torso);
    const col = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.04, 0.1), Lam(0xffffff));
    col.position.set(0, 0.74, 0);
    g.add(col);
    [-1, 1].forEach((s) => {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 0.08), Lam(shirt));
      arm.position.set(s * 0.2, 0.5, 0);
      g.add(arm);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.07), Lam(SKIN));
      hand.position.set(s * 0.2, 0.32, 0);
      g.add(hand);
    });
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), Lam(SKIN));
    head.position.set(0, 0.86, 0);
    g.add(head);
    const hairTop = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.22), Lam(hair));
    hairTop.position.set(0, 0.96, -0.01);
    const hairBack = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.04), Lam(hair));
    hairBack.position.set(0, 0.9, -0.11);
    g.add(hairTop, hairBack);
    [-1, 1].forEach((s) => {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.01), Basic(0xffffff));
      eye.position.set(s * 0.05, 0.88, 0.11);
      g.add(eye);
      const pup = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.01), Basic(0x1a1a2e));
      pup.position.set(s * 0.05, 0.87, 0.115);
      g.add(pup);
    });
    const badge = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), Basic(badgeColor));
    badge.position.set(0.16, 0.65, 0.07);
    g.add(badge);
  } else {
    [-1, 1].forEach((s) => {
      const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.1, 0.22), Lam(pants));
      thigh.position.set(s * 0.09, 0.42, -0.05);
      g.add(thigh);
      const shin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.25, 0.1), Lam(pants));
      shin.position.set(s * 0.09, 0.24, -0.15);
      g.add(shin);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.05, 0.14), Lam(0x222222));
      shoe.position.set(s * 0.09, 0.1, -0.15);
      g.add(shoe);
    });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.16), Lam(shirt));
    torso.position.set(0, 0.62, 0);
    g.add(torso);
    const col = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.04, 0.1), Lam(0xffffff));
    col.position.set(0, 0.77, 0);
    g.add(col);
    [-1, 1].forEach((s) => {
      const ua = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.08), Lam(shirt));
      ua.position.set(s * 0.2, 0.6, -0.04);
      g.add(ua);
      const fa = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.2), Lam(SKIN));
      fa.position.set(s * 0.2, 0.52, -0.18);
      g.add(fa);
    });
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), Lam(SKIN));
    head.position.set(0, 0.9, 0);
    g.add(head);
    const hairTop = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.22), Lam(hair));
    hairTop.position.set(0, 1.0, 0.01);
    const hairBack = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.04), Lam(hair));
    hairBack.position.set(0, 0.94, 0.11);
    g.add(hairTop, hairBack);
    [-1, 1].forEach((s) => {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.01), Basic(0xffffff));
      eye.position.set(s * 0.05, 0.92, -0.11);
      g.add(eye);
      const pup = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.01), Basic(0x1a1a2e));
      pup.position.set(s * 0.05, 0.91, -0.115);
      g.add(pup);
    });
    const badge = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), Basic(badgeColor));
    badge.position.set(0.16, 0.68, -0.06);
    g.add(badge);
  }
  return g;
}

interface AgentRig {
  group: THREE.Group; // moving wrapper — position/rotation updated for walking
  standGroup: THREE.Group;
  sitGroup: THREE.Group;
  legs: THREE.Mesh[]; // in standGroup, position.z-swing while walking
  monitorMat: THREE.MeshLambertMaterial;
  deskLight: THREE.PointLight;
  desk: THREE.Vector3;
  walkT: number;
  target: THREE.Vector3;
  seatRotY: number; // rotation to face when the current target is a seat
  moving: boolean;
  seated: boolean;
  wasWorking: boolean;
  inMeeting: boolean;
  nextWanderAt: number;
}

interface FloatBit {
  mesh: THREE.Mesh;
  baseY: number;
  phase: number;
  spin: number;
}

export function AgentDeck({
  statuses,
  selected,
  onOpen,
  onOpenOrchestrator,
}: {
  statuses: Record<string, AgentStatusInfo>;
  selected: Set<AgentId>;
  onToggleSelect: (id: AgentId) => void;
  onOpen: (id: AgentId) => void;
  onOpenOrchestrator: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rigsRef = useRef<Map<AgentId, AgentRig>>(new Map());
  const latestRef = useRef({ statuses, selected, onOpen, onOpenOrchestrator });
  const [cyberpunk, setCyberpunk] = useState(false);
  const cyberpunkRef = useRef(cyberpunk);

  useEffect(() => {
    latestRef.current = { statuses, selected, onOpen, onOpenOrchestrator };
  }, [statuses, selected, onOpen, onOpenOrchestrator]);
  useEffect(() => {
    cyberpunkRef.current = cyberpunk;
  }, [cyberpunk]);

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000c1e);
    scene.fog = new THREE.FogExp2(0x000c1e, 0.004);

    const camera = new THREE.PerspectiveCamera(30, host.clientWidth / host.clientHeight, 0.1, 500);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;
    host.appendChild(renderer.domElement);

    const target = new THREE.Vector3(0, 1.8, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 21;
    controls.maxDistance = 65;
    controls.minPolarAngle = 0.18;
    controls.maxPolarAngle = Math.PI / 2.3;
    const theta0 = Math.PI / 4.5;
    const phi0 = Math.PI / 4.5;
    const radius0 = 44;
    camera.position.set(
      radius0 * Math.sin(phi0) * Math.sin(theta0) + target.x,
      radius0 * Math.cos(phi0) + target.y,
      radius0 * Math.sin(phi0) * Math.cos(theta0) + target.z,
    );
    camera.lookAt(target);
    controls.update();

    // ---- Lighting ----
    const ambient = new THREE.AmbientLight(0xffffff, 0.75);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xfff8f0, 1.2);
    sun.position.set(12, 20, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -28;
    sun.shadow.camera.right = 28;
    sun.shadow.camera.top = 28;
    sun.shadow.camera.bottom = -28;
    sun.shadow.bias = -0.001;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xccddff, 0.4);
    fill.position.set(-10, 12, 0);
    scene.add(fill);
    scene.add(new THREE.HemisphereLight(0xdde8f0, 0xb0bec5, 0.4));

    // ---- Floor + inset carpet ----
    const floor = new THREE.Mesh(new THREE.BoxGeometry(FLOOR_W, 0.15, FLOOR_D), Lam(0xe8e8e8));
    floor.position.y = -0.075;
    floor.receiveShadow = true;
    scene.add(floor);
    const carpet = new THREE.Mesh(new THREE.BoxGeometry(13, 0.02, 10.4), Lam(0xd0d8e0));
    carpet.position.set(-3.9, 0.01, 0);
    carpet.receiveShadow = true;
    scene.add(carpet);

    // ---- Glass perimeter walls + 4 corner mullions ----
    const hx = FLOOR_W / 2;
    const hz = FLOOR_D / 2;
    const glass = GlassMat();
    ([
      [0, -hz, FLOOR_W, 4, 0.06],
      [0, hz, FLOOR_W, 4, 0.06],
      [-hx, 0, 0.06, 4, FLOOR_D],
      [hx, 0, 0.06, 4, FLOOR_D],
    ] as const).forEach(([x, z, w, h, d]) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), glass);
      wall.position.set(x, h / 2, z);
      scene.add(wall);
    });
    ([[-hx, -hz], [-hx, hz], [hx, -hz], [hx, hz]] as const).forEach(([x, z]) => {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.08, 4, 0.08), Lam(0xaabbcc));
      f.position.set(x, 2, z);
      scene.add(f);
    });

    // No ceiling at all — an earlier ceiling-slab + light-panel-grid pass
    // still read as unwanted stuff floating overhead from these camera
    // angles, so the office is open to the dark void above.

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

    // ---- Conference room: glass partitions, table, 6 chairs ----
    const raycastTargets: THREE.Object3D[] = [];
    ([
      [MEETING_ROOM_W, 0.06, MEETING_CENTER.x, MEETING_CENTER.z - MEETING_ROOM_D / 2],
      [MEETING_ROOM_W, 0.06, MEETING_CENTER.x, MEETING_CENTER.z + MEETING_ROOM_D / 2],
    ] as const).forEach(([w, d, x, z]) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 3.5, d), glass);
      wall.position.set(x, 1.75, z);
      scene.add(wall);
    });
    ([
      [0.06, MEETING_ROOM_D, MEETING_CENTER.x - MEETING_ROOM_W / 2, MEETING_CENTER.z],
      [0.06, MEETING_ROOM_D, MEETING_CENTER.x + MEETING_ROOM_W / 2, MEETING_CENTER.z],
    ] as const).forEach(([w, d, x, z]) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 3.5, d), glass);
      wall.position.set(x, 1.75, z);
      scene.add(wall);
    });
    const mTable = new THREE.Mesh(new THREE.BoxGeometry(4.9, 0.08, 2.0), Lam(0xdde4ec));
    mTable.position.set(MEETING_CENTER.x, 0.72, MEETING_CENTER.z);
    mTable.castShadow = true;
    scene.add(mTable);
    MEETING_SEATS.forEach((seat) => {
      const seatBox = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.4), Lam(0x37474f));
      seatBox.position.set(seat.x, 0.44, seat.z);
      scene.add(seatBox);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.42, 0.04), Lam(0x37474f));
      back.position.set(seat.x, 0.67, seat.z + (seat.ry === 0 ? 0.19 : -0.19));
      scene.add(back);
    });
    const meetingLabel = makeLabelSprite("CONFERENCE ROOM", "#38bdf8");
    meetingLabel.position.set(MEETING_CENTER.x, 4.3, MEETING_CENTER.z);
    scene.add(meetingLabel);

    // ---- Bookshelf, plants, sticky notes, lounge couch, floating particles ----
    const shelfFrame = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.4, 0.4), Lam(0xd8dde6));
    shelfFrame.position.set(SHELF_POS.x, 0.7, SHELF_POS.z);
    scene.add(shelfFrame);
    [0xef4444, 0xf97316, 0xeab308, 0x22c55e, 0x3b82f6, 0xa855f7, 0xec4899].forEach((c, i) => {
      const book = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.32), Lam(c));
      book.position.set(SHELF_POS.x - 0.5 + i * 0.16, 1.06, SHELF_POS.z);
      scene.add(book);
    });
    const cabinet = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.5), Lam(0x5a6472));
    cabinet.position.set(FILING_CABINET_POS.x, 0.55, FILING_CABINET_POS.z);
    cabinet.castShadow = true;
    scene.add(cabinet);
    const cabinetHandle = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.03), Basic(0xaabbcc));
    cabinetHandle.position.set(FILING_CABINET_POS.x, 0.7, FILING_CABINET_POS.z + 0.26);
    scene.add(cabinetHandle);

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
    PLANT_POS.forEach((p) => {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.35, 10), Lam(0x334155));
      pot.position.set(p.x, 0.18, p.z);
      scene.add(pot);
      const foliage = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), Lam(0x2f9e5c));
      foliage.position.set(p.x, 0.68, p.z);
      scene.add(foliage);
    });
    STICKY_POS.forEach((p, i) => {
      const note = new THREE.Mesh(
        new THREE.PlaneGeometry(0.28, 0.28),
        new THREE.MeshBasicMaterial({ color: i % 2 === 0 ? 0xf472b6 : 0xfacc15, side: THREE.DoubleSide }),
      );
      note.rotation.x = -Math.PI / 2;
      note.rotation.z = Math.random() * 0.6 - 0.3;
      note.position.set(p.x, p.y, p.z);
      scene.add(note);
    });
    const couch = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.8, 1.3), Lam(0x2e4a6b));
    couch.position.set(LANDMARKS[1].x, 0.4, LANDMARKS[1].z);
    scene.add(couch);
    const cooler = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 1.6, 12), Lam(0x2f9e5c, { emissive: 0x0f3a20 }));
    cooler.position.copy(LANDMARKS[0]).setY(0.8);
    scene.add(cooler);
    const floaters: FloatBit[] = [];
    for (let i = 0; i < 14; i++) {
      const size = 0.18 + Math.random() * 0.22;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({ color: FLOAT_COLORS[i % FLOAT_COLORS.length], transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
      );
      mesh.position.set((Math.random() - 0.5) * FLOOR_W * 0.85, 2 + Math.random() * 1.5, (Math.random() - 0.5) * FLOOR_D * 0.85);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      scene.add(mesh);
      floaters.push({ mesh, baseY: mesh.position.y, phase: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 0.6 });
    }

    // ---- Reception desk: branded sign + glow strip ----
    const rcDesk = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.9, 0.6), Lam(0x15803d));
    rcDesk.position.set(RECEPTION.x, 0.45, RECEPTION.z);
    rcDesk.castShadow = true;
    scene.add(rcDesk);
    const rcTop = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.04, 0.7), Lam(0xdde4ec));
    rcTop.position.set(RECEPTION.x, 0.92, RECEPTION.z);
    scene.add(rcTop);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 0.5),
      new THREE.MeshBasicMaterial({ map: makeSignTexture("FOOTRANK"), transparent: true }),
    );
    sign.position.set(RECEPTION.x, 0.5, RECEPTION.z + 0.31);
    scene.add(sign);
    const rcGlow = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.02, 0.02), Basic(0xffae3b));
    rcGlow.position.set(RECEPTION.x, 0.05, RECEPTION.z + 0.3);
    scene.add(rcGlow);
    const rcLight = new THREE.PointLight(0xffae3b, 0.4, 3.5, 2);
    rcLight.position.set(RECEPTION.x, 0.1, RECEPTION.z + 0.5);
    scene.add(rcLight);

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

    // ---- Desks + agents, grouped by department ----
    const rigs = rigsRef.current;
    let hairIdx = 0;

    function buildAgent(spec: AgentSpec, pos: { x: number; z: number }) {
      const accentColor = new THREE.Color(spec.accent).getHex();
      const desk = new THREE.Vector3(pos.x, 0, pos.z);

      // Desk legs + top
      ([[-0.65, -0.3], [0.65, -0.3], [-0.65, 0.3], [0.65, 0.3]] as const).forEach(([lx, lz]) => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.7, 0.06), Lam(0xbbccdd));
        leg.position.set(pos.x + lx, 0.35, pos.z + lz);
        leg.castShadow = true;
        scene.add(leg);
      });
      const deskTop = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.75), Lam(0xe8ecf0));
      deskTop.position.set(pos.x, 0.73, pos.z);
      deskTop.castShadow = true;
      deskTop.receiveShadow = true;
      scene.add(deskTop);

      const nameBar = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.03, 0.03), Basic(accentColor));
      nameBar.position.set(pos.x, 0.755, pos.z + 0.36);
      scene.add(nameBar);
      const label = makeLabelSprite(spec.id.toUpperCase(), spec.accent);
      label.position.set(pos.x, 1.9, pos.z);
      scene.add(label);

      // Monitor: base + stand + body, body carries a real-status emissive glow
      const monBase = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.02, 0.12), Lam(0xaabbcc));
      monBase.position.set(pos.x, 0.77, pos.z - 0.2);
      scene.add(monBase);
      const monStand = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.22, 0.03), Lam(0xaabbcc));
      monStand.position.set(pos.x, 0.88, pos.z - 0.2);
      scene.add(monStand);
      const monitorMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a, emissive: accentColor, emissiveIntensity: 0.15 });
      const monBody = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.52, 0.03), monitorMat);
      monBody.position.set(pos.x, 1.28, pos.z - 0.24);
      monBody.castShadow = true;
      scene.add(monBody);

      const deskLight = new THREE.PointLight(accentColor, 0, 3);
      deskLight.position.set(pos.x, 1.2, pos.z - 0.3);
      scene.add(deskLight);

      // Chair
      const cSeat = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.4), Lam(0x37474f));
      cSeat.position.set(pos.x, 0.44, pos.z + 0.55);
      scene.add(cSeat);
      const cBack = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.42, 0.04), Lam(0x37474f));
      cBack.position.set(pos.x, 0.67, pos.z + 0.55 + 0.19);
      scene.add(cBack);

      // Character: two poses (standing/sitting) sharing one moving wrapper
      const shirt = shade(spec.accent, 0.55);
      const pants = shade(spec.accent, 0.22);
      const hair = HAIR_COLORS[hairIdx % HAIR_COLORS.length];
      hairIdx++;
      const standGroup = buildCharacter(true, shirt, pants, hair, accentColor);
      const sitGroup = buildCharacter(false, shirt, pants, hair, accentColor);
      sitGroup.visible = false;

      const group = new THREE.Group();
      group.add(standGroup, sitGroup);
      group.position.set(pos.x, 0, pos.z + 0.9);
      scene.add(group);

      const clickTargets = [...standGroup.children, ...sitGroup.children, deskTop, monBody, label] as THREE.Object3D[];
      raycastTargets.push(...clickTargets);
      for (const obj of clickTargets) {
        (obj.userData as { agentId: AgentId }).agentId = spec.id;
      }

      rigs.set(spec.id, {
        group,
        standGroup,
        sitGroup,
        legs: (standGroup.userData.legs as THREE.Mesh[]) ?? [],
        monitorMat,
        deskLight,
        desk,
        walkT: 0,
        target: group.position.clone(),
        seatRotY: 0,
        moving: false,
        seated: false,
        wasWorking: false,
        inMeeting: false,
        nextWanderAt: performance.now() + 1500 + Math.random() * 3000,
      });
    }

    (Object.keys(DEPARTMENT_META) as DepartmentId[]).forEach((id) => {
      const meta = DEPARTMENT_META[id];
      const specs = departmentAgents(id);
      const positions = deskPositions(specs.length, meta.cols, meta.center.x, meta.center.z, meta.spacing);
      specs.forEach((spec, i) => buildAgent(spec, positions[i]));
    });

    // ---- Click-to-open-chat via raycasting ----
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    function onClick(ev: MouseEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(raycastTargets, false);
      if (hits.length > 0) {
        const data = hits[0].object.userData as { agentId?: AgentId; orchestrator?: boolean };
        if (data.orchestrator) latestRef.current.onOpenOrchestrator();
        else if (data.agentId) latestRef.current.onOpen(data.agentId);
      }
    }
    renderer.domElement.addEventListener("click", onClick);

    // ---- Resize ----
    function onResize() {
      if (!host) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    }
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(host);

    // ---- Animation loop ----
    let raf = 0;
    let lastTime = 0;
    const startTime = performance.now();
    let meetingActive = false;
    let meetingUntil = 0;
    let meetingNextAt = startTime + 8000 + Math.random() * 12000;
    const meetingAttendees: AgentId[] = [];

    function tick(now: number) {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (lastTime ? now - lastTime : 16) / 1000);
      lastTime = now;

      if (cyberpunkRef.current) {
        ambient.intensity = 0.12;
        sun.intensity = 0.08;
        renderer.toneMappingExposure = 0.55;
        scene.background = new THREE.Color(0x000814);
        (scene.fog as THREE.FogExp2).color.set(0x000814);
      } else {
        ambient.intensity = 0.75;
        sun.intensity = 1.2;
        renderer.toneMappingExposure = 1.3;
        scene.background = new THREE.Color(0x000c1e);
        (scene.fog as THREE.FogExp2).color.set(0x000c1e);
      }

      const elapsed = (now - startTime) / 1000;
      for (const f of floaters) {
        f.mesh.position.y = f.baseY + Math.sin(elapsed + f.phase) * 0.5;
        f.mesh.rotation.x += f.spin * dt;
        f.mesh.rotation.y += f.spin * dt * 0.7;
      }

      // Stand-up meeting scheduler: pull a few idle agents to the conference
      // room, hold them a while, release. An agent starting real work is
      // always pulled out immediately, so this never blocks a real cycle.
      if (!meetingActive && now > meetingNextAt) {
        const idle = Array.from(rigs.entries()).filter(([aid]) => (latestRef.current.statuses[aid]?.live ?? "idle") !== "working");
        if (idle.length >= 2) {
          const count = Math.min(idle.length, MEETING_SEATS.length, 3 + Math.floor(Math.random() * 4));
          const shuffled = idle.slice().sort(() => Math.random() - 0.5).slice(0, count);
          meetingAttendees.length = 0;
          shuffled.forEach(([aid, ar], i) => {
            const seat = MEETING_SEATS[i];
            ar.target = new THREE.Vector3(seat.x, 0, seat.z);
            ar.seatRotY = seat.ry;
            ar.moving = true;
            ar.seated = false;
            ar.inMeeting = true;
            meetingAttendees.push(aid);
          });
          meetingActive = true;
          meetingUntil = now + 18000 + Math.random() * 12000;
        } else {
          meetingNextAt = now + 10000;
        }
      }
      if (meetingActive && now > meetingUntil) {
        meetingActive = false;
        meetingNextAt = now + 40000 + Math.random() * 40000;
        for (const aid of meetingAttendees) {
          const ar = rigs.get(aid);
          if (ar) {
            ar.inMeeting = false;
            ar.seated = false;
            ar.nextWanderAt = now;
          }
        }
        meetingAttendees.length = 0;
      }

      for (const [id, r] of rigs) {
        const info = latestRef.current.statuses[id];
        const live: AgentLive = info?.live ?? "idle";
        const working = live === "working";

        if (r.inMeeting && working) r.inMeeting = false;

        if (!r.inMeeting) {
          if (working && !r.wasWorking) {
            r.target = r.desk.clone().setZ(r.desk.z + 0.9);
            r.seatRotY = 0;
            r.moving = true;
            r.seated = false;
          } else if (!working && r.wasWorking) {
            r.seated = false;
          }
          if (!working && !r.moving && now > r.nextWanderAt) {
            const goHome = Math.random() < 0.4;
            if (goHome) {
              r.target = r.desk.clone().setZ(r.desk.z + 0.9);
              r.seatRotY = 0;
            } else {
              r.target = LANDMARKS[Math.floor(Math.random() * LANDMARKS.length)].clone();
            }
            r.moving = true;
            r.seated = false;
            r.nextWanderAt = now + 4000 + Math.random() * 5000;
          }
        }
        r.wasWorking = working;

        if (r.moving) {
          const toTarget = r.target.clone().sub(r.group.position);
          const dist = toTarget.length();
          if (dist < 0.12) {
            r.moving = false;
            r.group.position.copy(r.target);
            const atDesk = r.target.distanceTo(r.desk.clone().setZ(r.desk.z + 0.9)) < 0.01;
            if ((atDesk && working) || r.inMeeting) {
              r.seated = true;
              r.group.rotation.y = r.seatRotY;
            }
          } else {
            toTarget.normalize();
            const speed = 2.2;
            r.group.position.addScaledVector(toTarget, speed * dt);
            if (!r.inMeeting || dist > 0.5) r.group.rotation.y = Math.atan2(toTarget.x, toTarget.z);
            r.walkT += dt * 10;
            for (const leg of r.legs) {
              leg.position.z = Math.sin(r.walkT + (leg.userData.phase as number)) * 0.08;
            }
          }
        }

        r.standGroup.visible = !r.seated;
        r.sitGroup.visible = r.seated;

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
    }
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
      rigs.clear();
    };
  }, []);

  return (
    <div className="relative w-full h-full">
      <div ref={hostRef} className="w-full h-full [&>canvas]:rounded-lg" />
      <button
        onClick={() => setCyberpunk((c) => !c)}
        className="absolute bottom-3 left-3 text-[10px] px-2 py-1 rounded font-display glass"
        style={{
          border: "1px solid var(--border)",
          color: cyberpunk ? "#00ff88" : "var(--text-dim)",
        }}
        title="Toggle lights off / cyberpunk mode"
      >
        {cyberpunk ? "Lights on" : "Lights off"}
      </button>
    </div>
  );
}
