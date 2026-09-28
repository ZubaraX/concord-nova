import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Permission, sortGuildChannels, type ChannelDTO } from "@nova/shared";
import { channelPerms, can, useData, type DataState } from "../store/data";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useMediaQuery(q: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(q);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(q).matches
  );
}

export const useIsMobile = () => useMediaQuery("(max-width: 767px)");
export const useIsWide = () => useMediaQuery("(min-width: 1180px)");

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Sidebar structure for a guild: categories with their visible children. */
export function useGuildChannels(guildId: string | null) {
  const channels = useData((s) => s.channels);
  const canManage = useData((s) => {
    if (!guildId) return false;
    const any = Object.values(s.channels).find((c) => c.guildId === guildId);
    return any ? can(channelPerms(s, any.id), Permission.MANAGE_CHANNELS) : false;
  });
  return useMemo(() => {
    if (!guildId) return [];
    const list = Object.values(channels).filter((c) => c.guildId === guildId && c.type !== "thread");
    return sortGuildChannels(list).filter((g) => !g.category || g.channels.length > 0 || canManage);
  }, [channels, guildId, canManage]);
}

export function useThreads(parentId: string): ChannelDTO[] {
  const channels = useData((s) => s.channels);
  return useMemo(
    () =>
      Object.values(channels)
        .filter((c) => c.type === "thread" && c.parentId === parentId && !c.thread?.archived)
        .sort((a, b) => ((b.lastMessageId ?? b.id) > (a.lastMessageId ?? a.id) ? 1 : -1)),
    [channels, parentId]
  );
}

export function usePerms(channelId: string | null | undefined): bigint {
  return useData((s) => channelPerms(s, channelId));
}

export function useTypingUsers(channelId: string | null): string[] {
  const typing = useData((s) => (channelId ? s.typing[channelId] : undefined));
  const me = useData((s) => s.me?.id);
  const now = useNow(1000);
  return useMemo(() => Object.entries(typing ?? {}).filter(([u, exp]) => exp > now && u !== me).map(([u]) => u), [typing, now, me]);
}

export function selectFirstTextChannel(s: DataState, guildId: string): string | null {
  const list = Object.values(s.channels).filter((c) => c.guildId === guildId && c.type !== "thread");
  for (const g of sortGuildChannels(list)) for (const c of g.channels) if (c.type === "text" || c.type === "announcement") return c.id;
  return null;
}

export function useEventListener<K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, capture = false) {
  const ref = useLatest(fn);
  useEffect(() => {
    const h = (e: WindowEventMap[K]) => ref.current(e);
    window.addEventListener(type, h, capture);
    return () => window.removeEventListener(type, h, capture);
  }, [type, capture, ref]);
}
