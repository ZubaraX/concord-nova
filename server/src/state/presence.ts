// Live presence per user, aggregated over all their connected sessions.
// status: invisible → offline for others; dnd/idle as chosen; online becomes
// idle automatically when every session reports inactivity (afk).
import type { Activity, ChosenStatus, ClientPlatform, CustomStatus, PresenceDTO, PresenceStatus } from "@nova/shared";

interface SessionPresence {
  sid: string;
  platform: ClientPlatform;
  afk: boolean;
  activities: Activity[];
}

class PresenceState {
  private sockets = new Map<string, Map<string, SessionPresence>>();
  private chosen = new Map<string, ChosenStatus>();
  private custom = new Map<string, CustomStatus | null>();
  private lastSent = new Map<string, string>();

  connect(userId: string, socketId: string, sess: Omit<SessionPresence, "afk" | "activities">, chosen: ChosenStatus, custom: CustomStatus | null) {
    let m = this.sockets.get(userId);
    if (!m) this.sockets.set(userId, (m = new Map()));
    m.set(socketId, { ...sess, afk: false, activities: [] });
    this.chosen.set(userId, chosen);
    this.custom.set(userId, custom);
  }

  disconnect(userId: string, socketId: string) {
    const m = this.sockets.get(userId);
    if (!m) return;
    m.delete(socketId);
    if (!m.size) this.sockets.delete(userId);
  }

  update(userId: string, socketId: string, patch: { afk?: boolean; activities?: Activity[] }) {
    const s = this.sockets.get(userId)?.get(socketId);
    if (!s) return;
    if (patch.afk !== undefined) s.afk = patch.afk;
    if (patch.activities) s.activities = patch.activities.slice(0, 3);
  }

  setChosen(userId: string, status: ChosenStatus) {
    this.chosen.set(userId, status);
  }

  setCustom(userId: string, custom: CustomStatus | null) {
    this.custom.set(userId, custom);
  }

  getChosen(userId: string): ChosenStatus | undefined {
    return this.chosen.get(userId);
  }

  isConnected(userId: string): boolean {
    return !!this.sockets.get(userId)?.size;
  }

  /** Active (not afk) on a desktop/web session — used to hold back phone pushes. */
  isActiveOnComputer(userId: string): boolean {
    for (const s of this.sockets.get(userId)?.values() ?? []) if (s.platform !== "mobile" && !s.afk) return true;
    return false;
  }

  get(userId: string): PresenceDTO {
    const sessions = [...(this.sockets.get(userId)?.values() ?? [])];
    const chosen = this.chosen.get(userId) ?? "online";
    let status: PresenceStatus;
    if (!sessions.length || chosen === "invisible") status = "offline";
    else if (chosen === "dnd") status = "dnd";
    else if (chosen === "idle" || sessions.every((s) => s.afk)) status = "idle";
    else status = "online";
    if (status === "offline") return { userId, status, customStatus: null, activities: [], platforms: [] };
    const custom = this.custom.get(userId) ?? null;
    const activities: Activity[] = [];
    for (const s of sessions) for (const a of s.activities) if (!activities.some((x) => x.name === a.name && x.type === a.type)) activities.push(a);
    return {
      userId,
      status,
      customStatus: custom && (!custom.expiresAt || custom.expiresAt > Date.now()) ? custom : null,
      activities,
      platforms: [...new Set(sessions.map((s) => s.platform))],
    };
  }

  /** Returns the DTO when it differs from what was last broadcast, else null. */
  diff(userId: string): PresenceDTO | null {
    const p = this.get(userId);
    const key = JSON.stringify(p);
    if (this.lastSent.get(userId) === key) return null;
    this.lastSent.set(userId, key);
    return p;
  }

  /** Users with at least one live connection (any status, invisible included). */
  connectedCount(): number {
    return this.sockets.size;
  }

  onlineUserIds(): string[] {
    return [...this.sockets.keys()].filter((u) => this.get(u).status !== "offline");
  }
}

export const presence = new PresenceState();
