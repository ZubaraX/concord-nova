import { create } from "zustand";
import type { AuthResponse, RegisterInput } from "@nova/shared";
import { api, onAuthLost, tokens } from "../lib/api";
import { bus } from "../lib/bus";
import { connectGateway, disconnectGateway } from "../lib/gateway";
import { resetData } from "./data";
import { resetMessages } from "./messages";

type Status = "anon" | "authed";

export const useSession = create<{ status: Status; endedReason: string | null }>(() => ({
  status: tokens.refresh ? "authed" : "anon",
  endedReason: null,
}));

function start(res: AuthResponse) {
  tokens.set(res.accessToken, res.refreshToken);
  useSession.setState({ status: "authed", endedReason: null });
  connectGateway();
}

export async function login(loginValue: string, password: string) {
  const res = await api<AuthResponse>("/api/auth/login", { method: "POST", body: { login: loginValue, password }, auth: false });
  start(res);
}

export async function register(input: RegisterInput) {
  const res = await api<AuthResponse & { joinedGuildId: string | null }>("/api/auth/register", { method: "POST", body: input, auth: false });
  start(res);
  return res.joinedGuildId;
}

function endSession(reason: string | null) {
  disconnectGateway();
  tokens.clear();
  resetData();
  resetMessages();
  useSession.setState({ status: "anon", endedReason: reason });
  bus.emit("logout", { reason: reason ?? "logout" });
}

export async function logout() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  endSession(null);
}

onAuthLost((reason) => {
  if (useSession.getState().status === "authed") endSession(reason);
});

bus.on("logout", ({ reason }) => {
  if (useSession.getState().status === "authed") endSession(reason);
});
