"use client";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { AGENTS, type AgentSpec } from "../../agents/registry";
import type { AgentId } from "../../lib/types";
import type { AgentStatusInfo, AgentLive } from "../../lib/agent-status";
import { TOOL_VISUAL, DEFAULT_TOOL_VISUAL } from "../../lib/tool-visual";

// Modeled on Gaurav2693/ai-office (github.com/Gaurav2693/ai-office, verified
// live at skill-deploy-qmm7droauc.vercel.app): a 3D voxel-style office —
// orbital camera, desks with glowing monitors, a glass-walled meeting room,
// landmark furniture agents wander to, a day/night light cycle, and a
// "lights off" neon mode. No external model assets, same as that project's
// own primitives-only approach and this codebase's prior Phaser scene.

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

// Landmarks idle agents wander to — mirrors ai-office's "water cooler,
// center, window, lounge" destination set.
const LANDMARKS: THREE.Vector3[] = [
  new THREE.Vector3(2, 0, 1), // water cooler
  new THREE.Vector3(-7, 0, 9), // lounge
  new THREE.Vector3(6, 0, -2), // center/window
];

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

interface AgentRig {
  group: THREE.Group; // whole character, moved for walking
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  torso: THREE.Mesh;
  head: THREE.Mesh;
  monitor: THREE.Mesh;
  monitorMat: THREE.MeshStandardMaterial;
  deskLight: THREE.PointLight;
  badge: THREE.Sprite | null;
  desk: THREE.Vector3;
  walkT: number; // walk-cycle phase
  target: THREE.Vector3;
  moving: boolean;
  seated: boolean;
  wasWorking: boolean;
  nextWanderAt: number;
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
    const camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 0.1, 200);
    camera.position.set(0, 24, 26);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 12;
    controls.maxDistance = 55;
    controls.maxPolarAngle = Math.PI * 0.48; // never dip below the floor
    controls.update();

    // ---- Lighting (day/night cycle drives sun + ambient below) ----
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(10, 22, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    scene.add(sun);

    // ---- Floor ----
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x1b2130, roughness: 0.9 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_W, FLOOR_D), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(Math.max(FLOOR_W, FLOOR_D), 24, 0x3a4560, 0x262c3d);
    (grid.material as THREE.Material).opacity = 0.35;
    (grid.material as THREE.Material).transparent = true;
    scene.add(grid);

    // ---- Meeting room (glass-walled box, back-right) ----
    const meetingCenter = new THREE.Vector3(11, 0, -9);
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x8ecbff,
      transparent: true,
      opacity: 0.18,
      roughness: 0.05,
      transmission: 0.6,
      metalness: 0,
    });
    const meetingWallGeo = new THREE.BoxGeometry(9, 3, 0.15);
    const wallN = new THREE.Mesh(meetingWallGeo, glassMat);
    wallN.position.set(meetingCenter.x, 1.5, meetingCenter.z - 4);
    scene.add(wallN);
    const wallS = wallN.clone();
    wallS.position.set(meetingCenter.x, 1.5, meetingCenter.z + 4);
    scene.add(wallS);
    const sideGeo = new THREE.BoxGeometry(0.15, 3, 8);
    const wallW = new THREE.Mesh(sideGeo, glassMat);
    wallW.position.set(meetingCenter.x - 4.5, 1.5, meetingCenter.z);
    scene.add(wallW);
    const wallE = wallW.clone();
    wallE.position.set(meetingCenter.x + 4.5, 1.5, meetingCenter.z);
    scene.add(wallE);
    const tableMat = new THREE.MeshStandardMaterial({ color: 0x2a3346 });
    const table = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 0.5, 24), tableMat);
    table.position.set(meetingCenter.x, 0.5, meetingCenter.z);
    table.castShadow = true;
    scene.add(table);

    // ---- Landmarks: water cooler + lounge ----
    const coolerMat = new THREE.MeshStandardMaterial({ color: 0x2f9e5c, emissive: 0x0f3a20 });
    const cooler = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 1.6, 12), coolerMat);
    cooler.position.copy(LANDMARKS[0]).setY(0.8);
    cooler.castShadow = true;
    scene.add(cooler);

    const loungeMat = new THREE.MeshStandardMaterial({ color: 0x3a2e42 });
    const sofa = new THREE.Mesh(new THREE.BoxGeometry(4, 0.9, 1.6), loungeMat);
    sofa.position.set(LANDMARKS[1].x, 0.45, LANDMARKS[1].z);
    sofa.castShadow = true;
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

    function buildAgent(spec: AgentSpec, pos: { x: number; z: number }) {
      const accent = hexToColor(spec.accent);
      const desk = new THREE.Vector3(pos.x, 0, pos.z);

      const deskMat = new THREE.MeshStandardMaterial({ color: 0x2a3346 });
      const deskMesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.7, 0.9), deskMat);
      deskMesh.position.set(pos.x, 0.35, pos.z);
      deskMesh.castShadow = true;
      deskMesh.receiveShadow = true;
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

      // Simple voxel humanoid — torso + head + two legs (legs animate the walk).
      const group = new THREE.Group();
      const legMat = new THREE.MeshStandardMaterial({ color: accent, opacity: 0.85, transparent: true });
      const legGeo = new THREE.BoxGeometry(0.18, 0.55, 0.18);
      const legL = new THREE.Mesh(legGeo, legMat);
      legL.position.set(-0.13, 0.275, 0);
      legL.castShadow = true;
      const legR = new THREE.Mesh(legGeo, legMat);
      legR.position.set(0.13, 0.275, 0);
      legR.castShadow = true;
      const torsoMat = new THREE.MeshStandardMaterial({ color: accent });
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.3), torsoMat);
      torso.position.set(0, 0.85, 0);
      torso.castShadow = true;
      const headMat = new THREE.MeshStandardMaterial({ color: 0xf0d9b5 });
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), headMat);
      head.position.set(0, 1.32, 0);
      head.castShadow = true;
      group.add(legL, legR, torso, head);
      group.position.set(pos.x, 0, pos.z + 0.9);
      scene.add(group);
      raycastTargets.push(torso, head);
      (torso.userData as { agentId: AgentId }).agentId = spec.id;
      (head.userData as { agentId: AgentId }).agentId = spec.id;

      rigs.set(spec.id, {
        group,
        legL,
        legR,
        torso,
        head,
        monitor,
        monitorMat,
        deskLight,
        badge: null,
        desk,
        walkT: 0,
        target: group.position.clone(),
        moving: false,
        seated: false,
        wasWorking: false,
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
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    }
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(host);

    // ---- Animation loop: walk physics, day/night cycle, render ----
    let raf = 0;
    let lastTime = 0;
    const start = performance.now();
    const DAY_CYCLE_MS = 120_000; // slow ambient cycle, not real 24h

    function tick(now: number) {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (lastTime ? now - lastTime : 16) / 1000);
      lastTime = now;

      // Day/night: sun angle + intensity + background sweep, unless cyberpunk mode overrides.
      if (!cyberpunkRef.current) {
        const phase = ((now - start) % DAY_CYCLE_MS) / DAY_CYCLE_MS; // 0..1
        const angle = phase * Math.PI * 2;
        const alt = Math.sin(angle); // -1 (night) .. 1 (noon)
        sun.intensity = 0.35 + Math.max(0, alt) * 0.9;
        ambient.intensity = 0.25 + Math.max(0, alt) * 0.35 + 0.1;
        const dusk = new THREE.Color(0x0a0a14);
        const noon = new THREE.Color(0x1b2130);
        const bg = dusk.clone().lerp(noon, Math.max(0, alt) * 0.5 + 0.5);
        scene.background = bg;
        sun.position.set(Math.cos(angle) * 20, 12 + alt * 10, Math.sin(angle) * 20);
      } else {
        sun.intensity = 0.12;
        ambient.intensity = 0.08;
        scene.background = new THREE.Color(0x03040a);
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
          }
        } else {
          r.legL.rotation.x = THREE.MathUtils.lerp(r.legL.rotation.x, 0, 0.1);
          r.legR.rotation.x = THREE.MathUtils.lerp(r.legR.rotation.x, 0, 0.1);
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
