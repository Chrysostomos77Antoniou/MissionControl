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
// orthographic camera, dark-navy void with a light desk floor, exposed
// ceiling truss + hanging panels, thin glass-wall mullions around the
// perimeter, a branded reception desk, a bookshelf, potted plants,
// floating decorative particles, and voxel characters with hair + arms.
// No external model assets, same as that project's primitives-only approach.

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
// center, window, lounge" destination set.
const LANDMARKS: THREE.Vector3[] = [
  new THREE.Vector3(2, 0, 1), // water cooler
  new THREE.Vector3(-7, 0, 9), // lounge
  new THREE.Vector3(6, 0, -2), // center/window
];

const RECEPTION = new THREE.Vector3(16, 0, 11);
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
}: {
  statuses: Record<string, AgentStatusInfo>;
  selected: Set<AgentId>;
  onToggleSelect: (id: AgentId) => void;
  onOpen: (id: AgentId) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rigsRef = useRef<Map<AgentId, AgentRig>>(new Map());
  const latestRef = useRef({ statuses, selected, onOpen });
  const [cyberpunk, setCyberpunk] = useState(false);
  const cyberpunkRef = useRef(cyberpunk);

  // Mirror the latest props/state into refs so the rAF loop (a closure set
  // up once in the mount effect below) always reads current values instead
  // of the ones captured at mount.
  useEffect(() => {
    latestRef.current = { statuses, selected, onOpen };
  }, [statuses, selected, onOpen]);
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

    // ---- Floor: single light desk-floor plane against the dark void, no grid ----
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xd7dbe3, roughness: 0.85 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_W, FLOOR_D), floorMat);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    // ---- Ceiling truss: cross-hatched beams + a few hanging panels ----
    const trussMat = new THREE.MeshStandardMaterial({ color: 0x1a2033, roughness: 0.8 });
    const trussY = 9;
    const spanX = FLOOR_W * 0.9;
    const spanZ = FLOOR_D * 0.9;
    const beamCountX = 5;
    const beamCountZ = 4;
    for (let i = 0; i < beamCountX; i++) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, spanZ), trussMat);
      beam.position.set(-spanX / 2 + (i / (beamCountX - 1)) * spanX, trussY, 0);
      scene.add(beam);
    }
    for (let i = 0; i < beamCountZ; i++) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(spanX, 0.25, 0.25), trussMat);
      beam.position.set(0, trussY, -spanZ / 2 + (i / (beamCountZ - 1)) * spanZ);
      scene.add(beam);
    }
    const panelMat = new THREE.MeshStandardMaterial({ color: 0x0e1420 });
    ([[-8, -4], [6, 3], [14, -8]] as const).forEach(([x, z]) => {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.9), panelMat);
      panel.position.set(x, trussY - 0.6, z);
      scene.add(panel);
    });

    // ---- Perimeter mullions: thin poles standing in for glass walls ----
    const mullionMat = new THREE.MeshStandardMaterial({ color: 0x8a93a8, emissive: 0x1c2434, emissiveIntensity: 0.3 });
    const mullionH = 3.2;
    function addMullions(x1: number, z1: number, x2: number, z2: number, count: number) {
      for (let i = 0; i < count; i++) {
        const t = i / (count - 1);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, mullionH, 6), mullionMat);
        pole.position.set(THREE.MathUtils.lerp(x1, x2, t), mullionH / 2, THREE.MathUtils.lerp(z1, z2, t));
        scene.add(pole);
      }
    }
    const hx = FLOOR_W / 2;
    const hz = FLOOR_D / 2;
    addMullions(-hx, -hz, hx, -hz, 9);
    addMullions(-hx, hz, hx, hz, 9);
    addMullions(-hx, -hz, -hx, hz, 7);
    addMullions(hx, -hz, hx, hz, 7);

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

    // ---- Landmarks: water cooler + lounge ----
    const coolerMat = new THREE.MeshStandardMaterial({ color: 0x2f9e5c, emissive: 0x0f3a20 });
    const cooler = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 1.6, 12), coolerMat);
    cooler.position.copy(LANDMARKS[0]).setY(0.8);
    scene.add(cooler);

    const loungeMat = new THREE.MeshStandardMaterial({ color: 0x3a2e42 });
    const sofa = new THREE.Mesh(new THREE.BoxGeometry(4, 0.9, 1.6), loungeMat);
    sofa.position.set(LANDMARKS[1].x, 0.45, LANDMARKS[1].z);
    scene.add(sofa);

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

    const raycastTargets: THREE.Object3D[] = [];
    const rigs = rigsRef.current;
    let hairIdx = 0;

    function buildAgent(spec: AgentSpec, pos: { x: number; z: number }) {
      const accent = hexToColor(spec.accent);
      const desk = new THREE.Vector3(pos.x, 0, pos.z);

      const deskMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f8 });
      const deskMesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.7, 0.9), deskMat);
      deskMesh.position.set(pos.x, 0.35, pos.z);
      scene.add(deskMesh);

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
      raycastTargets.push(torso, head);
      (torso.userData as { agentId: AgentId }).agentId = spec.id;
      (head.userData as { agentId: AgentId }).agentId = spec.id;

      rigs.set(spec.id, {
        group, legL, legR, armL, armR, torso, head, monitor, monitorMat, deskLight,
        desk, walkT: 0, target: group.position.clone(),
        moving: false, seated: false, wasWorking: false,
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
        const id = hits[0].object.userData.agentId as AgentId | undefined;
        if (id) latestRef.current.onOpen(id);
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

    // ---- Animation loop: walk physics, particle drift, render ----
    let raf = 0;
    let lastTime = 0;
    const startTime = performance.now();

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

      for (const [id, r] of rigs) {
        const info = latestRef.current.statuses[id];
        const live: AgentLive = info?.live ?? "idle";
        const working = live === "working";

        // State transition: start/stop working -> walk to/from desk.
        if (working && !r.wasWorking) {
          r.target = r.desk.clone().setZ(r.desk.z + 0.9);
          r.moving = true;
          r.seated = false;
        } else if (!working && r.wasWorking) {
          r.seated = false;
        }
        r.wasWorking = working;

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

        if (r.moving) {
          const toTarget = r.target.clone().sub(r.group.position);
          const dist = toTarget.length();
          if (dist < 0.12) {
            r.moving = false;
            r.group.position.copy(r.target);
            const atDesk = r.target.distanceTo(r.desk.clone().setZ(r.desk.z + 0.9)) < 0.01;
            if (atDesk && working) r.seated = true;
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
