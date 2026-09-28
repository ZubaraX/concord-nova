import type { ChannelDTO, MemberDTO, RoleDTO, UserDTO } from "./types";

export function userDisplayName(user: Pick<UserDTO, "username" | "displayName"> | null | undefined, member?: Pick<MemberDTO, "nick"> | null): string {
  if (!user) return "???";
  return member?.nick || user.displayName || user.username;
}

export function colorToHex(color: number | null | undefined): string | null {
  if (!color) return null;
  return "#" + color.toString(16).padStart(6, "0");
}

export function hexToColor(hex: string): number {
  const v = parseInt(hex.replace("#", ""), 16);
  return Number.isFinite(v) ? v & 0xffffff : 0;
}

/** Top-colored role of a member (highest position with a non-zero color). */
export function memberColor(roles: ReadonlyMap<string, RoleDTO> | Record<string, RoleDTO>, member: Pick<MemberDTO, "roles"> | null | undefined): number {
  if (!member) return 0;
  const get = (id: string) => (roles instanceof Map ? roles.get(id) : (roles as Record<string, RoleDTO>)[id]);
  let best: RoleDTO | undefined;
  for (const id of member.roles) {
    const r = get(id);
    if (r && r.color && (!best || r.position > best.position)) best = r;
  }
  return best?.color ?? 0;
}

const TYPE_RANK: Record<string, number> = { text: 0, announcement: 0, thread: 0, voice: 1, category: 2 };

/**
 * Sidebar order: uncategorized channels first, then categories each followed by
 * their children. Within a group: text before voice, then position, then id.
 */
export function sortGuildChannels(channels: readonly ChannelDTO[]): { category: ChannelDTO | null; channels: ChannelDTO[] }[] {
  const cmp = (a: ChannelDTO, b: ChannelDTO) =>
    (TYPE_RANK[a.type] ?? 0) - (TYPE_RANK[b.type] ?? 0) || a.position - b.position || (a.id < b.id ? -1 : 1);
  const cats = channels.filter((c) => c.type === "category").sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  const catIds = new Set(cats.map((c) => c.id));
  const loose = channels.filter((c) => c.type !== "category" && c.type !== "thread" && (!c.parentId || !catIds.has(c.parentId))).sort(cmp);
  const groups: { category: ChannelDTO | null; channels: ChannelDTO[] }[] = [];
  if (loose.length) groups.push({ category: null, channels: loose });
  for (const cat of cats) {
    groups.push({ category: cat, channels: channels.filter((c) => c.parentId === cat.id && c.type !== "thread").sort(cmp) });
  }
  return groups;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
