// Minimal typed pub/sub so feature modules (voice, notifications, calls)
// can react to gateway events without importing each other.
import type { DispatchEvent } from "@nova/shared";

export interface BusEvents {
  dispatch: DispatchEvent;
  ready: { first: boolean };
  focusComposer: { channelId: string };
  insertText: { channelId: string; text: string };
  toast: { kind?: "info" | "success" | "error"; text: string; action?: { label: string; run: () => void } };
  logout: { reason: string };
}

type Handler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;
const handlers: { [K in keyof BusEvents]?: Set<Handler<K>> } = {};

export const bus = {
  on<K extends keyof BusEvents>(k: K, fn: Handler<K>) {
    ((handlers[k] ??= new Set() as never) as Set<Handler<K>>).add(fn);
    return (): void => {
      (handlers[k] as Set<Handler<K>> | undefined)?.delete(fn);
    };
  },
  emit<K extends keyof BusEvents>(k: K, payload: BusEvents[K]) {
    for (const fn of (handlers[k] as Set<Handler<K>> | undefined) ?? []) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[bus:${k}]`, e);
      }
    }
  },
};

export const toast = (text: string, kind: BusEvents["toast"]["kind"] = "info", action?: BusEvents["toast"]["action"]) => bus.emit("toast", { text, kind, action });
