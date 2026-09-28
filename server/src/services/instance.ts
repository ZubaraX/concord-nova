// Instance-wide settings an instance admin can change from the app (stored in
// the InstanceSetting table; the environment provides the defaults).
import type { RegistrationMode } from "@nova/shared";
import { prisma } from "../db";
import { config } from "../config";

const state: { registration: RegistrationMode; serverName: string } = {
  registration: config.REGISTRATION,
  serverName: config.SERVER_NAME,
};

export const instance = {
  get registration(): RegistrationMode {
    return state.registration;
  },
  get serverName(): string {
    return state.serverName;
  },
};

export async function loadInstanceSettings() {
  for (const r of await prisma.instanceSetting.findMany()) {
    if (r.key === "registration" && (r.value === "open" || r.value === "invite" || r.value === "closed")) state.registration = r.value;
    if (r.key === "serverName" && r.value.trim()) state.serverName = r.value.trim();
  }
}

export async function setInstanceSettings(patch: Partial<typeof state>) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    await prisma.instanceSetting.upsert({ where: { key }, create: { key, value: String(value) }, update: { value: String(value) } });
    (state as Record<string, unknown>)[key] = value;
  }
  return { ...state };
}
