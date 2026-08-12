"use client";
import { useEffect, useRef } from "react";
import type Phaser from "phaser";
import { AGENTS, type AgentSpec } from "../../agents/registry";
import type { AgentId } from "../../lib/types";
import type { AgentStatusInfo, AgentLive } from "../../lib/agent-status";
import { TOOL_VISUAL, DEFAULT_TOOL_VISUAL } from "../../lib/tool-visual";

const OUTER_PAD = 14;
const HEADER_H = 22;
const FLOOR_PAD = 10;
const DOOR_W = 40;

// Dark, "professional/futuristic" palette (not the cream floor-plan look) —
// matching the AI Agent Session Center / OpenClaw office reference video.
const FLOOR_COLOR = 0x1b2130;
const WALL_COLOR = 0x3a4560;
const HEADER_BAR_COLOR = 0x0d111c;
const DOOR_COLOR = 0x5a6a90;
const DESK_COLOR = 0x2a3346;
const FURNITURE_COLOR = 0x2a3346;
const PLANT_COLOR = 0x2f9e5c;

type RoomKind = "briefing" | "meeting" | "arrivals" | "workspace" | "command" | "lounge" | "pantry" | "server";

// Each room gets its own accent color — a tinted rug, header stripe, and
// glow fixtures — so the floor plan reads as varied and colorful instead of
// one flat dark tone throughout.
const ROOM_TINT: Record<RoomKind, number> = {
  briefing: 0xf97316,
  meeting: 0x22c55e,
  arrivals: 0xa855f7,
  workspace: 0x3b82f6,
  command: 0xef4444,
  lounge: 0xec4899,
  pantry: 0xeab308,
  server: 0x14b8a6,
};

interface RoomDef {
  key: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: RoomKind;
}

// Fixed hand-laid floor plan (not a repeated grid) — 8 distinctly-purposed
// rooms sized and connected the way the reference office is: 3 rooms across
// the top, 2 big rooms in the middle, 3 rooms across the bottom.
const ROOM_DEFS: RoomDef[] = [
  { key: "briefing", label: "BRIEFING ROOM", x: 0, y: 0, w: 280, h: 210, kind: "briefing" },
  { key: "meeting", label: "MEETING ROOM", x: 280, y: 0, w: 280, h: 210, kind: "meeting" },
  { key: "arrivals", label: "ARRIVALS", x: 560, y: 0, w: 280, h: 210, kind: "arrivals" },
  { key: "workspace", label: "WORKSPACE", x: 0, y: 210, w: 430, h: 220, kind: "workspace" },
  { key: "command", label: "COMMAND CENTER", x: 430, y: 210, w: 410, h: 220, kind: "command" },
  { key: "lounge", label: "LOUNGE", x: 0, y: 430, w: 280, h: 210, kind: "lounge" },
  { key: "pantry", label: "PANTRY", x: 280, y: 430, w: 280, h: 210, kind: "pantry" },
  { key: "server", label: "SERVER ROOM", x: 560, y: 430, w: 280, h: 210, kind: "server" },
];

// Doorway connections — enough to make every room reachable from every
// other, not every possible touching pair (that would wall-to-wall the
// place with doors).
const DOOR_LINKS: [string, string][] = [
  ["briefing", "meeting"],
  ["meeting", "arrivals"],
  ["briefing", "workspace"],
  ["arrivals", "command"],
  ["workspace", "command"],
  ["workspace", "lounge"],
  ["lounge", "pantry"],
  ["pantry", "server"],
  ["command", "server"],
];

// Which room each agent's desk lives in — grouped by function, the way a
// real office seats people: DevOps/Cybersecurity in the watch room, the
// community-facing role at the front desk, everyone else in the open
// workspace. Briefing/Meeting/Lounge/Pantry/Server stay decorative-only
// (transient/atmospheric), matching how the reference video uses them.
const AGENT_ROOM: Record<AgentId, string> = {
  devops: "command",
  cybersecurity: "command",
  community: "arrivals",
  engineering: "workspace",
  developer: "workspace",
  qa: "workspace",
  uxdesign: "workspace",
  marketing: "workspace",
  growth: "workspace",
  competitive: "workspace",
  monetization: "workspace",
  copywriter: "workspace",
};

function hexToNum(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

function deskGrid(
  floor: { x0: number; y0: number; x1: number; y1: number },
  count: number,
  cols: number,
): { x: number; y: number }[] {
  const rows = Math.ceil(count / cols);
  const colW = (floor.x1 - floor.x0) / cols;
  const rowH = (floor.y1 - floor.y0) / rows;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({ x: floor.x0 + colW * c + colW / 2, y: floor.y0 + rowH * r + rowH / 2 });
  }
  return out;
}

interface RoomHandles {
  clickZone: Phaser.GameObjects.Rectangle;
  glow: Phaser.GameObjects.Rectangle;
  charContainer: Phaser.GameObjects.Container;
  legL: Phaser.GameObjects.Rectangle;
  legR: Phaser.GameObjects.Rectangle;
  torso: Phaser.GameObjects.Rectangle;
  head: Phaser.GameObjects.Arc;
  nameText: Phaser.GameObjects.Text;
  badgeDot: Phaser.GameObjects.Arc;
  badgeText: Phaser.GameObjects.Text;
  checkbox: Phaser.GameObjects.Rectangle;
  checkMark: Phaser.GameObjects.Text;
  statusText: Phaser.GameObjects.Text;
  consoleLights: Phaser.GameObjects.Image[];
  bobTween: Phaser.Tweens.Tween;
  glowTween: Phaser.Tweens.Tween | null;
  wiggleTween: Phaser.Tweens.Tween | null;
  moveTween: Phaser.Tweens.Tween | null;
  wanderEvent: Phaser.Time.TimerEvent;
  floor: { x0: number; y0: number; x1: number; y1: number };
  consolePos: { x: number; y: number };
  wasWorking: boolean;
  seated: boolean;
}

export function AgentDeck({
  statuses,
  selected,
  onToggleSelect,
  onOpen,
}: {
  statuses: Record<string, AgentStatusInfo>;
  selected: Set<AgentId>;
  onToggleSelect: (id: AgentId) => void;
  onOpen: (id: AgentId) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const roomsRef = useRef<Map<AgentId, RoomHandles>>(new Map());
  const latestRef = useRef({ statuses, selected, onToggleSelect, onOpen });
  latestRef.current = { statuses, selected, onToggleSelect, onOpen };

  // Boot the game once. All later prop changes are applied imperatively via
  // roomsRef in the effect below — recreating the Phaser.Game on every 10s
  // status poll would restart every walk/bob tween and freeze the room
  // between polls instead of feeling continuously alive.
  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;

    (async () => {
      const Phaser = (await import("phaser")).default;
      if (disposed || !hostRef.current) return;

      const prefersReducedMotion =
        typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      const bx0 = OUTER_PAD;
      const by0 = OUTER_PAD;
      const bx1 = OUTER_PAD + Math.max(...ROOM_DEFS.map((r) => r.x + r.w));
      const by1 = OUTER_PAD + Math.max(...ROOM_DEFS.map((r) => r.y + r.h));
      const width = bx1 + OUTER_PAD;
      const height = by1 + OUTER_PAD;
      const byKey = new Map(ROOM_DEFS.map((r) => [r.key, r]));

      class DeckScene extends Phaser.Scene {
        moteTexture!: string;

        // Phaser renders Text objects to an offscreen canvas at `resolution`
        // pixels-per-CSS-pixel, then scales that bitmap. Scale.FIT stretches
        // the whole game canvas well above 1x on most windows, so text left
        // at the default resolution (1) blurs badly once magnified — a
        // higher resolution here renders it dense enough to stay crisp.
        mkText(x: number, y: number, str: string, style: Phaser.Types.GameObjects.Text.TextStyle) {
          return this.add.text(x, y, str, { resolution: 4, ...style });
        }

        create() {
          const g = this.make.graphics({ x: 0, y: 0 });
          g.fillStyle(0xffffff, 1);
          g.fillCircle(3, 3, 3);
          g.generateTexture("mote", 6, 6);
          g.destroy();
          this.moteTexture = "mote";

          // One continuous building shell — a single dark floor + outer wall
          // the whole team shares, not N disconnected panels.
          this.add
            .rectangle((bx0 + bx1) / 2, (by0 + by1) / 2, bx1 - bx0, by1 - by0, FLOOR_COLOR, 1)
            .setStrokeStyle(4, WALL_COLOR, 1);

          const grid = this.add.graphics();
          grid.lineStyle(1, 0xffffff, 0.03);
          const step = 16;
          for (let gx = bx0; gx <= bx1; gx += step) grid.lineBetween(gx, by0, gx, by1);
          for (let gy = by0; gy <= by1; gy += step) grid.lineBetween(bx0, gy, bx1, gy);

          // Room shells: header bar + label, per distinct room (not per
          // agent — several agents can share one room).
          for (const room of ROOM_DEFS) {
            const rx0 = bx0 + room.x;
            const ry0 = by0 + room.y;
            const cx = rx0 + room.w / 2;
            const cy = ry0 + room.h / 2;
            const tint = ROOM_TINT[room.kind];

            // Colored floor wash + rug, unique per room — this is what
            // actually makes the plan read as varied/colorful instead of
            // one flat dark tone throughout.
            this.add.rectangle(cx, cy + HEADER_H / 2, room.w - 4, room.h - HEADER_H - 4, tint, 0.05);
            this.add
              .rectangle(cx, cy + HEADER_H / 2 + 6, room.w - 60, room.h - HEADER_H - 50, tint, 0.09)
              .setStrokeStyle(1, tint, 0.3);

            this.add.rectangle(cx, ry0 + HEADER_H / 2, room.w - 3, HEADER_H, HEADER_BAR_COLOR, 0.95);
            this.add.rectangle(cx, ry0 + HEADER_H - 1, room.w - 3, 2, tint, 0.9); // accent stripe under header
            this.mkText(rx0 + 8, ry0 + HEADER_H / 2, room.label, {
              fontFamily: "monospace",
              fontSize: "11px",
              fontStyle: "bold",
              color: "#eef1f8",
            }).setOrigin(0, 0.5);

            // A little colored ceiling light in each far corner.
            for (const [dx, dy] of [
              [22, HEADER_H + 20],
              [room.w - 22, room.h - 20],
            ]) {
              const lamp = this.add.image(rx0 + dx, ry0 + dy, "mote").setTint(tint).setAlpha(0.5).setScale(1.4);
              if (!prefersReducedMotion) {
                this.tweens.add({
                  targets: lamp,
                  alpha: { from: 0.25, to: 0.6 },
                  duration: 1800 + Math.random() * 1200,
                  yoyo: true,
                  repeat: -1,
                });
              }
            }

            this.buildFurniture(room, rx0, ry0, tint);
          }

          // Doorways: an open gap in the shared wall between linked rooms,
          // plus a little door-frame icon in the gap.
          const walls = this.add.graphics();
          const doors = this.add.graphics();
          walls.lineStyle(4, WALL_COLOR, 1);
          doors.fillStyle(DOOR_COLOR, 0.9);
          for (const [ka, kb] of DOOR_LINKS) {
            const a = byKey.get(ka)!;
            const b = byKey.get(kb)!;
            this.connectRooms(walls, doors, a, b, bx0, by0);
          }

          // Agents: grouped into their assigned room, laid out on a desk
          // grid within that room's floor.
          const byRoom = new Map<string, AgentSpec[]>();
          for (const spec of AGENTS) {
            const key = AGENT_ROOM[spec.id];
            (byRoom.get(key) ?? byRoom.set(key, []).get(key)!).push(spec);
          }
          for (const [key, agents] of byRoom) {
            const room = byKey.get(key)!;
            const rx0 = bx0 + room.x;
            const ry0 = by0 + room.y;
            const floor = {
              x0: rx0 + FLOOR_PAD,
              y0: ry0 + HEADER_H + 6,
              x1: rx0 + room.w - FLOOR_PAD,
              y1: ry0 + room.h - FLOOR_PAD,
            };
            const cols = agents.length <= 2 ? agents.length : agents.length <= 6 ? 3 : 5;
            const desks = deskGrid(floor, agents.length, cols);
            agents.forEach((spec, i) => this.buildAgent(spec, floor, desks[i]));
          }
        }

        // Draws an open doorway in the wall shared by two adjacent rooms —
        // works out which edge they share from their fixed coordinates.
        connectRooms(
          walls: Phaser.GameObjects.Graphics,
          doors: Phaser.GameObjects.Graphics,
          a: RoomDef,
          b: RoomDef,
          bx0: number,
          by0: number,
        ) {
          if (Math.abs(a.y + a.h - b.y) < 1) {
            const x0 = bx0 + Math.max(a.x, b.x);
            const x1 = bx0 + Math.min(a.x + a.w, b.x + b.w);
            const midX = (x0 + x1) / 2;
            const wallY = by0 + a.y + a.h;
            walls.lineBetween(x0, wallY, midX - DOOR_W / 2, wallY);
            walls.lineBetween(midX + DOOR_W / 2, wallY, x1, wallY);
            doors.fillRect(midX - DOOR_W / 2 + 5, wallY - 3, DOOR_W - 10, 6);
          } else if (Math.abs(b.y + b.h - a.y) < 1) {
            this.connectRooms(walls, doors, b, a, bx0, by0);
          } else if (Math.abs(a.x + a.w - b.x) < 1) {
            const y0 = by0 + Math.max(a.y, b.y);
            const y1 = by0 + Math.min(a.y + a.h, b.y + b.h);
            const midY = (y0 + y1) / 2;
            const wallX = bx0 + a.x + a.w;
            walls.lineBetween(wallX, y0, wallX, midY - DOOR_W / 2);
            walls.lineBetween(wallX, midY + DOOR_W / 2, wallX, y1);
            doors.fillRect(wallX - 3, midY - DOOR_W / 2 + 5, 6, DOOR_W - 10);
          } else if (Math.abs(b.x + b.w - a.x) < 1) {
            this.connectRooms(walls, doors, b, a, bx0, by0);
          }
        }

        // A small potted plant — cheap, repeatable detail that reads as
        // "furnished" without needing real sprite assets.
        plant(x: number, y: number) {
          this.add.rectangle(x, y + 6, 10, 8, 0x5a4630, 1).setStrokeStyle(1, 0x3a2c1e, 0.8);
          this.add.circle(x, y - 3, 8, PLANT_COLOR, 0.9);
          this.add.circle(x - 4, y, 5, PLANT_COLOR, 0.7);
          this.add.circle(x + 4, y, 5, PLANT_COLOR, 0.7);
        }

        // Decorative-only furniture per room kind — evocative, not literal
        // pixel-art reproduction (drawn from primitives, no external assets).
        buildFurniture(room: RoomDef, rx0: number, ry0: number, tint: number) {
          const cx = rx0 + room.w / 2;
          const cy = ry0 + room.h / 2;
          const f = (x: number, y: number, w: number, h: number, color = FURNITURE_COLOR) =>
            this.add.rectangle(x, y, w, h, color, 1).setStrokeStyle(1, WALL_COLOR, 0.7);
          const screen = (x: number, y: number, w: number, h: number) => {
            f(x, y, w, h, 0x0d111c);
            this.add.rectangle(x, y, w - 6, h - 6, tint, 0.35);
          };
          switch (room.kind) {
            case "briefing": {
              screen(cx, ry0 + HEADER_H + 26, 100, 16);
              for (let row = 0; row < 3; row++)
                for (let col = 0; col < 5; col++)
                  f(rx0 + 26 + col * 44, ry0 + HEADER_H + 66 + row * 34, 26, 12);
              this.plant(rx0 + 20, ry0 + room.h - 26);
              this.plant(rx0 + room.w - 20, ry0 + room.h - 26);
              break;
            }
            case "meeting": {
              f(cx, cy + 6, 130, 60); // table
              this.add.rectangle(cx, cy + 6, 118, 48, tint, 0.15);
              for (let i = 0; i < 6; i++) {
                const angle = (i / 6) * Math.PI * 2;
                f(cx + Math.cos(angle) * 90, cy + 6 + Math.sin(angle) * 50, 14, 10);
              }
              screen(cx, ry0 + HEADER_H + 20, 60, 12);
              this.plant(rx0 + 20, ry0 + room.h - 24);
              break;
            }
            case "arrivals": {
              f(cx, ry0 + HEADER_H + 24, 76, 22);
              this.add.rectangle(cx, ry0 + HEADER_H + 24, 64, 12, tint, 0.2);
              for (let i = 0; i < 3; i++) f(rx0 + 40 + i * 60, ry0 + room.h - 50, 26, 14); // waiting chairs
              this.plant(rx0 + room.w - 24, ry0 + HEADER_H + 24);
              this.plant(rx0 + 24, ry0 + room.h - 24);
              break;
            }
            case "lounge": {
              f(rx0 + 70, cy + 10, 90, 26, 0x3a2e42);
              f(rx0 + 190, cy - 10, 26, 70, 0x3a2e42);
              f(cx + 10, cy + 40, 50, 24);
              this.add.rectangle(cx + 10, cy + 40, 38, 14, tint, 0.2);
              this.plant(rx0 + 24, ry0 + room.h - 24);
              this.plant(rx0 + room.w - 24, ry0 + HEADER_H + 20);
              break;
            }
            case "pantry": {
              f(cx, ry0 + room.h - FLOOR_PAD - 16, 150, 22);
              this.add.rectangle(cx, ry0 + room.h - FLOOR_PAD - 16, 138, 10, tint, 0.18);
              f(rx0 + 30, cy - 6, 26, 46); // fridge
              f(rx0 + room.w - 30, cy - 6, 26, 26); // microwave/counter unit
              this.plant(rx0 + room.w - 26, ry0 + room.h - 26);
              break;
            }
            case "server": {
              for (let i = 0; i < 5; i++) {
                f(rx0 + 40 + i * 44, cy, 22, 96, 0x11151f);
                this.add.rectangle(rx0 + 40 + i * 44, cy - 30, 14, 6, tint, 0.6);
                this.add.rectangle(rx0 + 40 + i * 44, cy - 18, 14, 6, tint, 0.35);
              }
              break;
            }
            case "command": {
              // A big wall-of-screens — world map + a couple of chart-like
              // strips — the "mission control" focal point of the office.
              const wallY = ry0 + HEADER_H + 40;
              f(cx, wallY, room.w - 40, 66, 0x0d111c);
              this.add.rectangle(cx, wallY, room.w - 56, 54, tint, 0.16);
              const mapDots = this.add.graphics();
              mapDots.fillStyle(tint, 0.55);
              for (let i = 0; i < 40; i++) {
                mapDots.fillRect(
                  cx - (room.w - 70) / 2 + Phaser.Math.Between(0, room.w - 70),
                  wallY - 20 + Phaser.Math.Between(0, 40),
                  2,
                  2,
                );
              }
              this.plant(rx0 + 20, ry0 + room.h - 24);
              this.plant(rx0 + room.w - 20, ry0 + room.h - 24);
              break;
            }
            case "workspace": {
              this.plant(rx0 + 16, ry0 + room.h - 20);
              this.plant(rx0 + room.w - 16, ry0 + HEADER_H + 18);
              break;
            }
          }
        }

        buildAgent(spec: AgentSpec, floor: RoomHandles["floor"], consolePos: { x: number; y: number }) {
          const accent = hexToNum(spec.accent);

          const glow = this.add
            .rectangle(consolePos.x, consolePos.y, 64, 56, accent, 0)
            .setStrokeStyle(2, accent, 0);
          const clickZone = this.add
            .rectangle(consolePos.x, consolePos.y, 66, 58, 0x000000, 0)
            .setInteractive({ useHandCursor: true });
          clickZone.on("pointerdown", () => latestRef.current.onOpen(spec.id));

          // Small rug under the desk, tinted to the AGENT's own accent — a
          // splash of per-person color inside a shared department room.
          this.add.rectangle(consolePos.x, consolePos.y + 14, 46, 24, accent, 0.08);
          this.add.rectangle(consolePos.x, consolePos.y + 4, 26, 14, DESK_COLOR, 1).setStrokeStyle(1, WALL_COLOR, 0.7);
          this.add.rectangle(consolePos.x, consolePos.y - 2, 16, 9, 0x0d111c, 1);
          this.add.rectangle(consolePos.x, consolePos.y - 2, 12, 5, accent, 0.3);
          const consoleLights = [-4, 4].map((dx) =>
            this.add.image(consolePos.x + dx, consolePos.y - 2, "mote").setTint(accent).setAlpha(0.6).setScale(0.55),
          );

          // Long role names ("Community & Trust/Safety") would otherwise
          // overflow into the neighboring desk at this cell width — wrap
          // instead of clipping or bleeding sideways.
          const nameText = this.mkText(consolePos.x, consolePos.y - 34, spec.name, {
            fontFamily: "monospace",
            fontSize: "8px",
            color: "#eef1f8",
            align: "center",
            wordWrap: { width: 78 },
          }).setOrigin(0.5, 1);
          const statusText = this.mkText(consolePos.x, consolePos.y - 22, "idle", {
            fontFamily: "monospace",
            fontSize: "8px",
            color: "#9aa5b8",
          }).setOrigin(0.5, 1);

          const startX = Phaser.Math.Between(floor.x0 + 10, floor.x1 - 10);
          const startY = Phaser.Math.Between(floor.y0 + 10, floor.y1 - 10);
          const legL = this.add.rectangle(-3, 10, 3, 7, accent, 0.7);
          const legR = this.add.rectangle(3, 10, 3, 7, accent, 0.7);
          const torso = this.add.rectangle(0, 2, 12, 12, accent, 0.9);
          const head = this.add.circle(0, -8, 5, accent);
          const charContainer = this.add.container(startX, startY, [legL, legR, torso, head]);

          const bobTween = this.tweens.add({
            targets: charContainer,
            y: `+=2`,
            duration: 700 + Math.random() * 300,
            yoyo: true,
            repeat: -1,
            ease: "Sine.easeInOut",
          });
          if (prefersReducedMotion) bobTween.pause();

          const badgeDot = this.add.circle(0, 0, 3.5, 0xffaa00).setVisible(false);
          const badgeText = this.mkText(0, 0, "", { fontFamily: "monospace", fontSize: "8px", color: "#ffaa00" })
            .setOrigin(0.5, 1)
            .setVisible(false);

          const checkbox = this.add
            .rectangle(consolePos.x - 26, consolePos.y - 22, 9, 9, 0x000000, 0.4)
            .setStrokeStyle(1, 0x8a8a93, 0.9)
            .setInteractive({ useHandCursor: true });
          checkbox.on(
            "pointerdown",
            (_p: Phaser.Input.Pointer, _lx: number, _ly: number, event: { stopPropagation: () => void }) => {
              event.stopPropagation();
              latestRef.current.onToggleSelect(spec.id);
            },
          );
          const checkMark = this.mkText(consolePos.x - 26, consolePos.y - 22, "✓", {
            fontFamily: "monospace",
            fontSize: "9px",
            color: "#00ff88",
          })
            .setOrigin(0.5)
            .setVisible(false);

          const room: RoomHandles = {
            clickZone,
            glow,
            charContainer,
            legL,
            legR,
            torso,
            head,
            nameText,
            badgeDot,
            badgeText,
            checkbox,
            checkMark,
            statusText,
            consoleLights,
            bobTween,
            glowTween: null,
            wiggleTween: null,
            moveTween: null,
            wanderEvent: this.time.addEvent({
              delay: 1600 + Math.random() * 1600,
              loop: true,
              callback: () => this.wander(spec.id),
            }),
            floor,
            consolePos,
            wasWorking: false,
            seated: false,
          };
          roomsRef.current.set(spec.id, room);
        }

        // Idle behaviour: stroll to a new random spot on the shared room
        // floor. Skipped entirely while actually working (seated at the
        // desk instead) — the timer keeps ticking either way so it resumes
        // wandering immediately once the agent goes idle again.
        wander(id: AgentId) {
          const r = roomsRef.current.get(id);
          // Idle wandering is pure ambiance with no informational value, so
          // it's the first thing to cut for reduced-motion users — agents
          // simply stand still until a real state change (start/stop
          // working) moves them.
          if (!r || r.wasWorking || prefersReducedMotion) return;
          const tx = Phaser.Math.Between(r.floor.x0 + 10, r.floor.x1 - 10);
          const ty = Phaser.Math.Between(r.floor.y0 + 10, r.floor.y1 - 10);
          this.walkTo(r, tx, ty);
        }

        setSeated(r: RoomHandles, seated: boolean) {
          r.seated = seated;
          r.legL.setVisible(!seated);
          r.legR.setVisible(!seated);
          r.torso.y = seated ? 5 : 2;
          r.head.y = seated ? -5 : -8;
          if (seated) {
            r.bobTween.pause();
            r.charContainer.setAngle(0);
            r.wiggleTween?.stop();
            r.wiggleTween = prefersReducedMotion
              ? null
              : this.tweens.add({
                  targets: r.torso,
                  x: { from: -0.6, to: 0.6 },
                  duration: 160,
                  yoyo: true,
                  repeat: -1,
                });
          } else {
            r.wiggleTween?.stop();
            r.wiggleTween = null;
            r.torso.x = 0;
            if (!prefersReducedMotion) r.bobTween.resume();
          }
        }

        walkTo(r: RoomHandles, tx: number, ty: number, onArrive?: () => void) {
          if (r.seated) this.setSeated(r, false);
          const dx = tx - r.charContainer.x;
          if (Math.abs(dx) > 1) r.charContainer.setScale(dx < 0 ? -1 : 1, 1);
          const dist = Phaser.Math.Distance.Between(r.charContainer.x, r.charContainer.y, tx, ty);
          r.moveTween?.stop();
          r.wiggleTween?.stop();
          // bobTween also animates charContainer.y — left running, it fights
          // moveTween's interpolation of the same property and stutters the
          // walk. Pause it for the trip; resumed on arrival (unless the
          // agent is about to sit down, which pauses it again anyway).
          r.bobTween.pause();
          r.wiggleTween = prefersReducedMotion
            ? null
            : this.tweens.add({
                targets: r.charContainer,
                angle: { from: -4, to: 4 },
                duration: 180,
                yoyo: true,
                repeat: -1,
              });
          r.moveTween = this.tweens.add({
            targets: r.charContainer,
            x: tx,
            y: ty,
            duration: Math.max(350, dist * 14),
            ease: "Cubic.easeInOut",
            onComplete: () => {
              r.wiggleTween?.stop();
              r.wiggleTween = null;
              r.charContainer.setAngle(0);
              if (!onArrive && !prefersReducedMotion) r.bobTween.resume();
              onArrive?.();
            },
          });
        }

        applyStatus(id: AgentId, info: AgentStatusInfo | undefined, isSelected: boolean) {
          const r = roomsRef.current.get(id);
          if (!r) return;

          r.checkMark.setVisible(isSelected);
          r.checkbox.setFillStyle(isSelected ? 0x00ff88 : 0x000000, isSelected ? 0.25 : 0.4);

          const live: AgentLive = info?.live ?? "idle";
          r.statusText.setText(live === "working" ? "working" : live === "done" ? "ready" : "idle");
          r.statusText.setColor(live === "working" ? "#ff8a1f" : live === "done" ? "#ffd23f" : "#6b7280");

          const nowWorking = live === "working";
          if (nowWorking && !r.wasWorking) {
            this.walkTo(r, r.consolePos.x, r.consolePos.y - 6, () => this.setSeated(r, true));
          } else if (!nowWorking && r.wasWorking) {
            r.moveTween?.stop();
            this.setSeated(r, false);
          }
          r.wasWorking = nowWorking;

          const idleColor = hexToNum(AGENTS.find((a) => a.id === id)!.accent);
          if (nowWorking) {
            const visual = (info?.tool && TOOL_VISUAL[info.tool]) || DEFAULT_TOOL_VISUAL;
            r.badgeDot
              .setPosition(r.charContainer.x, r.charContainer.y - 22)
              .setVisible(true)
              .setFillStyle(visual.color);
            r.badgeText
              .setPosition(r.charContainer.x, r.charContainer.y - 26)
              .setVisible(true)
              .setText(visual.label)
              .setColor(`#${visual.color.toString(16).padStart(6, "0")}`);
            r.consoleLights.forEach((l) => l.setTint(visual.color).setAlpha(1));
            if (!r.glowTween) {
              r.glowTween = this.tweens.add({
                targets: r.glow,
                alpha: { from: 0, to: 0.45 },
                duration: 550,
                yoyo: true,
                repeat: -1,
              });
              r.glow.setStrokeStyle(2, visual.color, 0);
            }
          } else {
            r.badgeDot.setVisible(false);
            r.badgeText.setVisible(false);
            r.consoleLights.forEach((l) => l.setTint(idleColor).setAlpha(0.5));
            if (r.glowTween) {
              r.glowTween.stop();
              r.glowTween = null;
              r.glow.setStrokeStyle(2, idleColor, 0);
            }
          }
        }

        update() {
          for (const r of roomsRef.current.values()) {
            if (r.badgeDot.visible) {
              r.badgeDot.setPosition(r.charContainer.x, r.charContainer.y - 22);
              r.badgeText.setPosition(r.charContainer.x, r.charContainer.y - 26);
            }
          }
        }
      }

      const game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: hostRef.current,
        width,
        height,
        transparent: true,
        scene: DeckScene,
        // pixelArt forces nearest-neighbor canvas scaling — fine for the
        // solid-color shapes here, but it mangles text glyphs once
        // Scale.FIT stretches the canvas above 1x (which it does on most
        // windows). Smooth/antialiased scaling keeps text legible; these
        // shapes have no fine pixel detail to lose from it.
        render: { antialias: true, roundPixels: true },
        // Fixed internal resolution scaled to fill whatever space the host
        // div has, so it reads as full-screen on any window size.
        scale: {
          mode: Phaser.Scale.FIT,
          autoCenter: Phaser.Scale.CENTER_BOTH,
          width,
          height,
        },
      });
      gameRef.current = game;

      game.events.once("ready", () => {
        const scene = game.scene.keys[Object.keys(game.scene.keys)[0]] as InstanceType<typeof DeckScene>;
        for (const spec of AGENTS) {
          scene.applyStatus(spec.id, latestRef.current.statuses[spec.id], latestRef.current.selected.has(spec.id));
        }
      });
    })();

    const rooms = roomsRef.current;
    return () => {
      disposed = true;
      gameRef.current?.destroy(true);
      gameRef.current = null;
      rooms.clear();
    };
  }, []);

  // Reconcile visuals on every status/selection change without touching the
  // Phaser.Game instance itself.
  useEffect(() => {
    const scene = gameRef.current?.scene.keys[Object.keys(gameRef.current.scene.keys)[0]] as
      | { applyStatus: (id: AgentId, info: AgentStatusInfo | undefined, sel: boolean) => void }
      | undefined;
    if (!scene) return;
    for (const spec of AGENTS) {
      scene.applyStatus(spec.id, statuses[spec.id], selected.has(spec.id));
    }
  }, [statuses, selected]);

  return <div ref={hostRef} className="w-full h-full flex items-center justify-center [&>canvas]:rounded-lg" />;
}
