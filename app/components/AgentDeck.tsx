"use client";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { AGENTS, type AgentSpec } from "../../agents/registry";
import type { AgentId } from "../../lib/types";
import type { AgentStatusInfo, AgentLive } from "../../lib/agent-status";
import { TOOL_VISUAL, DEFAULT_TOOL_VISUAL } from "../../lib/tool-visual";

// Matched to the reference screenshot from Gaurav2693/ai-office
// (github.com/Gaurav2693/ai-office, verified live at
// skill-deploy-qmm7droauc.vercel.app): a flat-shaded isometric office —
// orthographic camera, dark-navy void with a light desk floor, a branded
// reception desk, a bookshelf, potted plants, floating decorative
// particles, and voxel characters with hair + arms. Every desk carries a
// billboarded nameplate + accent-colored edge strip so it's clear at a
// glance whose desk is whose, and the desk/monitor/nameplate are all
// click targets (not just the character) so it still opens that agent's
// chat even while they're off wandering. No external model assets, same
// as that project's primitives-only approach.

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

const FLOOR_W = 42;
const FLOOR_D = 32;
const FRUSTUM = 30; // orthographic frustum height — tuned so the floor + props fit at default zoom

// Landmarks idle agents wander to — mirrors ai-office's "water cooler,
// center, window, lounge" destination set. Index 1 (lounge) doubles as
// the couch's position below.
const LANDMARKS: THREE.Vector3[] = [
  new THREE.Vector3(2, 0, 1), // water cooler
  new THREE.Vector3(-4, 0, -5), // lounge
  new THREE.Vector3(6, 0, -2), // center/window
];

const ORCH_DESK = new THREE.Vector3(-7, 0, 9);
const RECEPTION = new THREE.Vector3(16, 0, 11);
const MEETING_CENTER = new THREE.Vector3(11, 0, -9);
const MEETING_ROOM_W = 9;
const MEETING_ROOM_D = 7;
const MEETING_SEATS: THREE.Vector3[] = [-1.15, 0, 1.15].flatMap((dx) =>
  [-1.0, 1.0].map((dz) => new THREE.Vector3(MEETING_CENTER.x + dx, 0, MEETING_CENTER.z + dz)),
);
const SHELF_POS = new THREE.Vector3(-19, 0, -13);
const PLANT_POS: THREE.Vector3[] = [
  new THREE.Vector3(-20, 0, -14),
  new THREE.Vector3(-9, 0, 13),
  new THREE.Vector3(18, 0, -13),
  new THREE.Vector3(9, 0, 14),
];
const STICKY_POS: THREE.Vector3[] = [
  new THREE.Vector3(2.6, 0.01, 3.4),
  new THREE.Vector3(-1.4, 0.01, 6.8),
  new THREE.Vector3(-14.2, 0.01, -7.6),
  new THREE.Vector3(4.6, 0.01, 7.1),
];
const HAIR_COLORS = [0x2b2b2b, 0x4a3222, 0x1a1a1a, 0x6b4423, 0x3a2a1a, 0x262626];
const FLOAT_COLORS = [0x22d3ee, 0xec4899, 0x38bdf8, 0xf472b6];

function hexToColor(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

function deskPositions(count: number, cols: number, cx: number, cz: number, spacing = 3.4) {
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

// Small billboarded nameplate that floats above a desk so it's readable
// even when the character wanders off — sprites always face the camera.
// White text (max contrast at small on-screen sizes) inside an
// accent-colored outline; font auto-shrinks so long ids never clip.
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

function applyFrustum(camera: THREE.OrthographicCamera, aspect: number) {
  camera.left = (-FRUSTUM * aspect) / 2;
  camera.right = (FRUSTUM * aspect) / 2;
  camera.top = FRUSTUM / 2;
  camera.bottom = -FRUSTUM / 2;
  camera.updateProjectionMatrix();
}

interface AgentRig {
  group: THREE.Group; // whole character, moved for walking
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  torso: THREE.Mesh;
  head: THREE.Mesh;
  monitor: THREE.Mesh;
  monitorMat: THREE.MeshStandardMaterial;
  deskLight: THREE.PointLight;
  desk: THREE.Vector3;
  walkT: number; // walk-cycle phase
  target: THREE.Vector3;
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

  // Mirror the latest props/state into refs so the rAF loop (a closure set
  // up once in the mount effect below) always reads current values instead
  // of the ones captured at mount.
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
    scene.background = new THREE.Color(0x0a0e1a);

    const aspect = host.clientWidth / host.clientHeight;
    const camera = new THREE.OrthographicCamera(
      (-FRUSTUM * aspect) / 2,
      (FRUSTUM * aspect) / 2,
      FRUSTUM / 2,
      -FRUSTUM / 2,
      0.1,
      200,
    );
    camera.position.set(26, 22, 30);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minZoom = 0.5;
    controls.maxZoom = 2.4;
    controls.maxPolarAngle = Math.PI * 0.46; // never dip below the floor
    controls.update();

    // ---- Lighting: flat, soft — no dramatic shadows, matching the reference's flat-shaded look ----
    const ambient = new THREE.AmbientLight(0xffffff, 0.72);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 0.55);
    sun.position.set(10, 20, 10);
    scene.add(sun);

    // ---- Floor: light desk-floor plane against the dark void, with faint tile seams ----
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xd7dbe3, roughness: 0.85 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_W, FLOOR_D), floorMat);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    const seamPts: number[] = [];
    const seamSpacing = 7;
    for (let x = -FLOOR_W / 2 + seamSpacing; x < FLOOR_W / 2; x += seamSpacing) {
      seamPts.push(x, 0.01, -FLOOR_D / 2, x, 0.01, FLOOR_D / 2);
    }
    for (let z = -FLOOR_D / 2 + seamSpacing; z < FLOOR_D / 2; z += seamSpacing) {
      seamPts.push(-FLOOR_W / 2, 0.01, z, FLOOR_W / 2, 0.01, z);
    }
    const seamGeo = new THREE.BufferGeometry();
    seamGeo.setAttribute("position", new THREE.Float32BufferAttribute(seamPts, 3));
    scene.add(new THREE.LineSegments(seamGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07 })));

    // ---- Ceiling truss + perimeter mullions: thin, semi-transparent, sparse —
    // tuned down from a first pass that used dense near-black beams, which
    // read as a solid black grid over the floor from steep top-down angles. ----
    const trussMat = new THREE.MeshStandardMaterial({ color: 0x5c6785, transparent: true, opacity: 0.35 });
    const trussY = 9.5;
    const spanX = FLOOR_W * 0.85;
    const spanZ = FLOOR_D * 0.85;
    for (let i = 0; i < 4; i++) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, spanZ), trussMat);
      beam.position.set(-spanX / 2 + (i / 3) * spanX, trussY, 0);
      scene.add(beam);
    }
    for (let i = 0; i < 3; i++) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(spanX, 0.12, 0.12), trussMat);
      beam.position.set(0, trussY, -spanZ / 2 + (i / 2) * spanZ);
      scene.add(beam);
    }
    const mullionMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ba, transparent: true, opacity: 0.4 });
    const mullionH = 3.0;
    function addMullions(x1: number, z1: number, x2: number, z2: number, count: number) {
      for (let i = 0; i < count; i++) {
        const t = i / (count - 1);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, mullionH, 6), mullionMat);
        pole.position.set(THREE.MathUtils.lerp(x1, x2, t), mullionH / 2, THREE.MathUtils.lerp(z1, z2, t));
        scene.add(pole);
      }
    }
    const hx = FLOOR_W / 2;
    const hz = FLOOR_D / 2;
    addMullions(-hx, -hz, hx, -hz, 6);
    addMullions(-hx, hz, hx, hz, 6);
    addMullions(-hx, -hz, -hx, hz, 5);
    addMullions(hx, -hz, hx, hz, 5);

    // ---- Conference room: glass-walled, with a table + 6 chairs where agents periodically hold meetings ----
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.16, roughness: 0.15 });
    const roomWallH = 3.0;
    function addGlassWall(w: number, d: number, x: number, z: number) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, roomWallH, d), glassMat);
      wall.position.set(x, roomWallH / 2, z);
      scene.add(wall);
    }
    addGlassWall(MEETING_ROOM_W, 0.12, MEETING_CENTER.x, MEETING_CENTER.z - MEETING_ROOM_D / 2);
    addGlassWall(MEETING_ROOM_W, 0.12, MEETING_CENTER.x, MEETING_CENTER.z + MEETING_ROOM_D / 2);
    addGlassWall(0.12, MEETING_ROOM_D, MEETING_CENTER.x - MEETING_ROOM_W / 2, MEETING_CENTER.z);
    addGlassWall(0.12, MEETING_ROOM_D, MEETING_CENTER.x + MEETING_ROOM_W / 2, MEETING_CENTER.z);
    const meetingTable = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.5, 1.6), new THREE.MeshStandardMaterial({ color: 0x2a3346 }));
    meetingTable.position.set(MEETING_CENTER.x, 0.5, MEETING_CENTER.z);
    scene.add(meetingTable);
    MEETING_SEATS.forEach((seat) => {
      const mChair = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.5), new THREE.MeshStandardMaterial({ color: 0x475569 }));
      mChair.position.set(seat.x, 0.22, seat.z);
      scene.add(mChair);
    });
    const meetingLabel = makeLabelSprite("CONFERENCE ROOM", "#38bdf8");
    meetingLabel.position.set(MEETING_CENTER.x, roomWallH + 0.7, MEETING_CENTER.z);
    scene.add(meetingLabel);

    // ---- Lounge couch ----
    const couch = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.8, 1.3), new THREE.MeshStandardMaterial({ color: 0x2e4a6b }));
    couch.position.set(LANDMARKS[1].x, 0.4, LANDMARKS[1].z);
    scene.add(couch);

    // ---- Reception desk: branded sign + a freestanding monitor plinth ----
    const deskBody = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.0, 0.7), new THREE.MeshStandardMaterial({ color: 0x0e1522 }));
    deskBody.position.set(RECEPTION.x, 0.5, RECEPTION.z);
    scene.add(deskBody);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.65), new THREE.MeshBasicMaterial({ map: makeSignTexture("FOOTRANK"), transparent: true }));
    sign.position.set(RECEPTION.x, 0.62, RECEPTION.z + 0.36);
    scene.add(sign);
    const standBase = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.5), new THREE.MeshStandardMaterial({ color: 0x1c2433 }));
    standBase.position.set(RECEPTION.x + 2.5, 0.45, RECEPTION.z - 0.3);
    scene.add(standBase);
    const standScreen = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.6, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x0a0e16, emissive: 0x1fb6ff, emissiveIntensity: 0.5 }),
    );
    standScreen.position.set(RECEPTION.x + 2.5, 1.05, RECEPTION.z - 0.3);
    scene.add(standScreen);

    // ---- Bookshelf: frame + a rainbow row of book blocks ----
    const shelfFrame = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.4, 0.4), new THREE.MeshStandardMaterial({ color: 0xd8dde6 }));
    shelfFrame.position.set(SHELF_POS.x, 0.7, SHELF_POS.z);
    scene.add(shelfFrame);
    const bookColors = [0xef4444, 0xf97316, 0xeab308, 0x22c55e, 0x3b82f6, 0xa855f7, 0xec4899];
    bookColors.forEach((c, i) => {
      const book = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.32), new THREE.MeshStandardMaterial({ color: c }));
      book.position.set(SHELF_POS.x - 0.5 + i * 0.16, 1.06, SHELF_POS.z);
      scene.add(book);
    });

    // ---- Potted plants ----
    PLANT_POS.forEach((p) => {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.35, 10), new THREE.MeshStandardMaterial({ color: 0x334155 }));
      pot.position.set(p.x, 0.18, p.z);
      scene.add(pot);
      const foliage = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), new THREE.MeshStandardMaterial({ color: 0x2f9e5c }));
      foliage.position.set(p.x, 0.68, p.z);
      scene.add(foliage);
    });

    // ---- Sticky notes: small flat cards resting on the floor ----
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

    // ---- Floating decorative particles ----
    const floaters: FloatBit[] = [];
    for (let i = 0; i < 14; i++) {
      const size = 0.18 + Math.random() * 0.22;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({ color: FLOAT_COLORS[i % FLOAT_COLORS.length], transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
      );
      mesh.position.set((Math.random() - 0.5) * FLOOR_W * 0.8, 2 + Math.random() * 7, (Math.random() - 0.5) * FLOOR_D * 0.8);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      scene.add(mesh);
      floaters.push({ mesh, baseY: mesh.position.y, phase: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 0.6 });
    }

    const raycastTargets: THREE.Object3D[] = [];

    // ---- Water cooler landmark ----
    const coolerMat = new THREE.MeshStandardMaterial({ color: 0x2f9e5c, emissive: 0x0f3a20 });
    const cooler = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 1.6, 12), coolerMat);
    cooler.position.copy(LANDMARKS[0]).setY(0.8);
    scene.add(cooler);

    // ---- Orchestrator's desk — a distinct standalone desk, click opens the Orchestrator chat ----
    const orchDesk = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 1.0), new THREE.MeshStandardMaterial({ color: 0x241a33 }));
    orchDesk.position.set(ORCH_DESK.x, 0.45, ORCH_DESK.z);
    scene.add(orchDesk);
    const orchNamebar = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 0.06, 0.08),
      new THREE.MeshStandardMaterial({ color: 0xffae3b, emissive: 0xffae3b, emissiveIntensity: 0.5 }),
    );
    orchNamebar.position.set(ORCH_DESK.x, 0.94, ORCH_DESK.z + 0.52);
    scene.add(orchNamebar);
    const orchLabel = makeLabelSprite("ORCHESTRATOR", "#ffae3b");
    orchLabel.position.set(ORCH_DESK.x, 1.75, ORCH_DESK.z);
    scene.add(orchLabel);
    (orchDesk.userData as { orchestrator: boolean }).orchestrator = true;
    (orchLabel.userData as { orchestrator: boolean }).orchestrator = true;
    raycastTargets.push(orchDesk, orchLabel);

    // ---- Desks + agents, grouped by zone ----
    const byZone = new Map<Zone, AgentSpec[]>();
    for (const spec of AGENTS) {
      const z = AGENT_ZONE[spec.id];
      (byZone.get(z) ?? byZone.set(z, []).get(z)!).push(spec);
    }
    const zoneCenters: Record<Zone, { cx: number; cz: number; cols: number }> = {
      command: { cx: -13, cz: -9, cols: 2 },
      arrivals: { cx: -13, cz: 7, cols: 1 },
      workspace: { cx: 1, cz: 5, cols: 3 },
    };

    const rigs = rigsRef.current;
    let hairIdx = 0;

    function buildAgent(spec: AgentSpec, pos: { x: number; z: number }) {
      const accent = hexToColor(spec.accent);
      const desk = new THREE.Vector3(pos.x, 0, pos.z);

      const deskMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f8 });
      const deskMesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.7, 0.9), deskMat);
      deskMesh.position.set(pos.x, 0.35, pos.z);
      scene.add(deskMesh);

      const chair = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.5), new THREE.MeshStandardMaterial({ color: 0x3f4a5c }));
      chair.position.set(pos.x, 0.21, pos.z + 0.65);
      scene.add(chair);

      // Accent-colored edge strip so a desk reads as "whose" at a glance,
      // even before the nameplate above it is legible.
      const nameBar = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.06, 0.06),
        new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.4 }),
      );
      nameBar.position.set(pos.x, 0.71, pos.z + 0.46);
      scene.add(nameBar);

      const label = makeLabelSprite(spec.id.toUpperCase(), spec.accent);
      label.position.set(pos.x, 1.9, pos.z);
      scene.add(label);

      const monitorMat = new THREE.MeshStandardMaterial({
        color: 0x0d111c,
        emissive: accent,
        emissiveIntensity: 0.15,
      });
      const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.06), monitorMat);
      monitor.position.set(pos.x, 0.95, pos.z - 0.35);
      scene.add(monitor);

      const deskLight = new THREE.PointLight(accent.getHex(), 0, 3);
      deskLight.position.set(pos.x, 1.2, pos.z - 0.3);
      scene.add(deskLight);

      // Voxel humanoid — hair + torso + arms + head + two legs (legs/arms animate the walk).
      const group = new THREE.Group();
      const legMat = new THREE.MeshStandardMaterial({ color: accent, opacity: 0.85, transparent: true });
      const legGeo = new THREE.BoxGeometry(0.18, 0.55, 0.18);
      const legL = new THREE.Mesh(legGeo, legMat);
      legL.position.set(-0.13, 0.275, 0);
      const legR = new THREE.Mesh(legGeo, legMat);
      legR.position.set(0.13, 0.275, 0);
      const torsoMat = new THREE.MeshStandardMaterial({ color: accent });
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.3), torsoMat);
      torso.position.set(0, 0.85, 0);
      const armMat = new THREE.MeshStandardMaterial({ color: accent, opacity: 0.9, transparent: true });
      const armGeo = new THREE.BoxGeometry(0.13, 0.5, 0.13);
      const armL = new THREE.Mesh(armGeo, armMat);
      armL.position.set(-0.32, 0.82, 0);
      const armR = new THREE.Mesh(armGeo, armMat);
      armR.position.set(0.32, 0.82, 0);
      const headMat = new THREE.MeshStandardMaterial({ color: 0xf0d9b5 });
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), headMat);
      head.position.set(0, 1.32, 0);
      const hairMat = new THREE.MeshStandardMaterial({ color: HAIR_COLORS[hairIdx % HAIR_COLORS.length] });
      hairIdx++;
      const hair = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.34), hairMat);
      hair.position.set(0, 1.5, -0.02);
      group.add(legL, legR, torso, armL, armR, head, hair);
      group.position.set(pos.x, 0, pos.z + 0.9);
      scene.add(group);
      raycastTargets.push(torso, head, deskMesh, monitor, label);
      for (const obj of [torso, head, deskMesh, monitor, label]) {
        (obj.userData as { agentId: AgentId }).agentId = spec.id;
      }

      rigs.set(spec.id, {
        group, legL, legR, armL, armR, torso, head, monitor, monitorMat, deskLight,
        desk, walkT: 0, target: group.position.clone(),
        moving: false, seated: false, wasWorking: false, inMeeting: false,
        nextWanderAt: performance.now() + 1500 + Math.random() * 3000,
      });
    }

    for (const [zone, specs] of byZone) {
      const { cx, cz, cols } = zoneCenters[zone];
      const positions = deskPositions(specs.length, cols, cx, cz);
      specs.forEach((spec, i) => buildAgent(spec, positions[i]));
    }

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
      applyFrustum(camera, host.clientWidth / host.clientHeight);
      renderer.setSize(host.clientWidth, host.clientHeight);
    }
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(host);

    // ---- Animation loop: walk physics, particle drift, meetings, render ----
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

      if (!cyberpunkRef.current) {
        ambient.intensity = 0.72;
        sun.intensity = 0.55;
        scene.background = new THREE.Color(0x0a0e1a);
      } else {
        ambient.intensity = 0.14;
        sun.intensity = 0.08;
        scene.background = new THREE.Color(0x03050d);
      }

      const elapsed = (now - startTime) / 1000;
      for (const f of floaters) {
        f.mesh.position.y = f.baseY + Math.sin(elapsed + f.phase) * 0.6;
        f.mesh.rotation.x += f.spin * dt;
        f.mesh.rotation.y += f.spin * dt * 0.7;
      }

      // Stand-up meeting scheduler: periodically pull a few currently-idle
      // agents to the conference room, hold them there a while, then
      // release them back to their normal desk/wander behavior. Purely
      // decorative — an agent that starts real work is released early
      // (below) so it never delays an actual cycle.
      if (!meetingActive && now > meetingNextAt) {
        const idle = Array.from(rigs.entries()).filter(([aid]) => (latestRef.current.statuses[aid]?.live ?? "idle") !== "working");
        if (idle.length >= 2) {
          const count = Math.min(idle.length, MEETING_SEATS.length, 3 + Math.floor(Math.random() * 4));
          const shuffled = idle.slice().sort(() => Math.random() - 0.5).slice(0, count);
          meetingAttendees.length = 0;
          shuffled.forEach(([aid, ar], i) => {
            ar.target = MEETING_SEATS[i].clone();
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

        // Real work always outranks a simulated meeting.
        if (r.inMeeting && working) r.inMeeting = false;

        if (!r.inMeeting) {
          // State transition: start/stop working -> walk to/from desk.
          if (working && !r.wasWorking) {
            r.target = r.desk.clone().setZ(r.desk.z + 0.9);
            r.moving = true;
            r.seated = false;
          } else if (!working && r.wasWorking) {
            r.seated = false;
          }

          // Idle wander: occasionally head to a landmark and back.
          if (!working && !r.moving && now > r.nextWanderAt) {
            const goHome = Math.random() < 0.4;
            r.target = goHome
              ? r.desk.clone().setZ(r.desk.z + 0.9)
              : LANDMARKS[Math.floor(Math.random() * LANDMARKS.length)].clone();
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
            if ((atDesk && working) || r.inMeeting) r.seated = true;
          } else {
            toTarget.normalize();
            const speed = 2.4;
            r.group.position.addScaledVector(toTarget, speed * dt);
            r.group.rotation.y = Math.atan2(toTarget.x, toTarget.z);
            r.walkT += dt * 9;
            const swing = Math.sin(r.walkT) * 0.35;
            r.legL.rotation.x = swing;
            r.legR.rotation.x = -swing;
            r.armL.rotation.x = -swing * 0.7;
            r.armR.rotation.x = swing * 0.7;
          }
        } else {
          r.legL.rotation.x = THREE.MathUtils.lerp(r.legL.rotation.x, 0, 0.1);
          r.legR.rotation.x = THREE.MathUtils.lerp(r.legR.rotation.x, 0, 0.1);
          r.armL.rotation.x = THREE.MathUtils.lerp(r.armL.rotation.x, 0, 0.1);
          r.armR.rotation.x = THREE.MathUtils.lerp(r.armR.rotation.x, 0, 0.1);
        }

        // Seated pose: crouch the group, hide legs.
        const seatY = r.seated ? -0.28 : 0;
        r.group.position.y = THREE.MathUtils.lerp(r.group.position.y, seatY, 0.15);
        r.legL.visible = !r.seated;
        r.legR.visible = !r.seated;

        // Monitor + desk light reflect activity.
        if (working) {
          const visual = (info?.tool && TOOL_VISUAL[info.tool]) || DEFAULT_TOOL_VISUAL;
          r.monitorMat.emissive.setHex(visual.color);
          r.monitorMat.emissiveIntensity = cyberpunkRef.current ? 2.2 : 1.1;
          r.deskLight.intensity = cyberpunkRef.current ? 1.4 : 0.7;
          r.deskLight.color.setHex(visual.color);
        } else {
          r.monitorMat.emissiveIntensity = cyberpunkRef.current ? 0.5 : 0.15;
          r.deskLight.intensity = cyberpunkRef.current ? 0.25 : 0;
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
