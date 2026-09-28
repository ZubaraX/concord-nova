// Voice presence + DM calls. The source of truth is LiveKit: states change on
// its webhooks, on client `voice:sync` reports (verified against LiveKit), and
// a periodic reconcile corrects any drift — so the sidebar never shows ghosts
// after crashes, network drops or server restarts.
import { MessageType, Permission, hasPerm, type CallDTO, type VoiceSelfInput, type VoiceStateDTO } from "@nova/shared";
import { prisma } from "../db";
import { cache } from "./cache";
import { toChannel, toUser, toUsers } from "../gateway/io";
import * as lk from "../voice/livekit";
import { pushToUser } from "../services/push";
import { createMessage } from "../services/messages";
import { loadMessage } from "../services/serialize";

interface Internal extends VoiceStateDTO {
  sid: string;
  channelId: string;
}

interface Call {
  channelId: string;
  initiatorId: string;
  ringing: Set<string>;
  startedAt: number;
  everJoined: Set<string>;
  ringTimer: ReturnType<typeof setTimeout> | null;
  messageId: string | null;
}

const RING_MS = 45_000;
const JOIN_GRACE_MS = 15_000;

class VoiceManager {
  private states = new Map<string, Internal>();
  private calls = new Map<string, Call>();
  private pendingSelf = new Map<string, VoiceSelfInput>();
  private serverFlags = new Map<string, { mute: boolean; deaf: boolean }>();
  private failures = 0;

  private dto(s: Internal): VoiceStateDTO {
    const { sid: _sid, ...rest } = s;
    return rest;
  }

  get(userId: string): VoiceStateDTO | undefined {
    const s = this.states.get(userId);
    return s ? this.dto(s) : undefined;
  }

  statesForGuild(guildId: string): VoiceStateDTO[] {
    return [...this.states.values()].filter((s) => s.guildId === guildId).map((s) => this.dto(s));
  }

  /** Instance-wide numbers for the admin overview. */
  stats(): { participants: number; rooms: number; calls: number } {
    return { participants: this.states.size, rooms: new Set([...this.states.values()].map((s) => s.channelId)).size, calls: this.calls.size };
  }

  countInChannel(channelId: string): number {
    let n = 0;
    for (const s of this.states.values()) if (s.channelId === channelId) n++;
    return n;
  }

  usersInChannel(channelId: string): string[] {
    return [...this.states.values()].filter((s) => s.channelId === channelId).map((s) => s.userId);
  }

  /** Voice states a user may see (visible guild channels + their private channels). */
  statesVisibleTo(userId: string): VoiceStateDTO[] {
    return [...this.states.values()].filter((s) => cache.canView(s.channelId, userId)).map((s) => this.dto(s));
  }

  private callDto(c: Call): CallDTO {
    return { channelId: c.channelId, initiatorId: c.initiatorId, ringing: [...c.ringing], startedAt: c.startedAt };
  }

  callsFor(userId: string): CallDTO[] {
    return [...this.calls.values()].filter((c) => cache.privates.get(c.channelId)?.recipients.has(userId)).map((c) => this.callDto(c));
  }

  setPendingSelf(userId: string, flags: VoiceSelfInput) {
    this.pendingSelf.set(userId, flags);
  }

  serverFlagsFor(guildId: string | null, userId: string) {
    return guildId ? this.serverFlags.get(`${guildId}:${userId}`) ?? { mute: false, deaf: false } : { mute: false, deaf: false };
  }

  /** What LiveKit should allow this user to publish / subscribe in a channel. */
  rightsFor(userId: string, channelId: string): { rights: lk.PublishRights; canSubscribe: boolean } {
    if (cache.privates.has(channelId)) return { rights: { mic: true, camera: true, screen: true }, canSubscribe: true };
    const bits = cache.channelPerms(channelId, userId);
    const flags = this.serverFlagsFor(cache.guildOf(channelId), userId);
    return {
      rights: {
        mic: hasPerm(bits, Permission.SPEAK) && !flags.mute,
        camera: hasPerm(bits, Permission.STREAM),
        screen: hasPerm(bits, Permission.STREAM),
      },
      canSubscribe: !flags.deaf,
    };
  }

  private emit(state: VoiceStateDTO, channelId: string) {
    toChannel(channelId, "VOICE_STATE_UPDATE", state);
  }

  async onJoin(userId: string, channelId: string, sid: string, joinedAt?: number) {
    const prev = this.states.get(userId);
    if (prev && prev.channelId === channelId) {
      prev.sid = sid; // reconnect / duplicate identity — same channel, keep state
      return;
    }
    const guildId = cache.guildOf(channelId);
    if (!guildId && !cache.privates.has(channelId)) return;
    if (!cache.can(channelId, userId, Permission.CONNECT)) {
      await lk.removeParticipant(channelId, userId);
      return;
    }
    if (prev) await this.onLeave(userId, prev.channelId);
    const self = this.pendingSelf.get(userId);
    const flags = this.serverFlagsFor(guildId, userId);
    const state: Internal = {
      userId,
      channelId,
      guildId,
      selfMute: self?.selfMute ?? false,
      selfDeaf: self?.selfDeaf ?? false,
      serverMute: flags.mute,
      serverDeaf: flags.deaf,
      selfVideo: false,
      selfStream: false,
      joinedAt: joinedAt ?? Date.now(),
      sid,
    };
    this.states.set(userId, state);
    this.emit(this.dto(state), channelId);
    if (!guildId) await this.callJoin(userId, channelId);
  }

  async onLeave(userId: string, channelId: string, sid?: string) {
    const s = this.states.get(userId);
    if (!s || s.channelId !== channelId) return;
    if (sid && s.sid !== sid) return; // an older duplicate session left — the user is still here
    this.states.delete(userId);
    this.emit({ ...this.dto(s), channelId: null, selfVideo: false, selfStream: false }, channelId);
    if (!s.guildId && this.countInChannel(channelId) === 0) await this.endCall(channelId);
  }

  updateSelf(userId: string, input: VoiceSelfInput) {
    this.pendingSelf.set(userId, input);
    const s = this.states.get(userId);
    if (!s) return;
    const next = { ...s, selfMute: !!input.selfMute, selfDeaf: !!input.selfDeaf, selfVideo: !!input.selfVideo, selfStream: !!input.selfStream };
    if (next.selfMute === s.selfMute && next.selfDeaf === s.selfDeaf && next.selfVideo === s.selfVideo && next.selfStream === s.selfStream) return;
    this.states.set(userId, next);
    this.emit(this.dto(next), next.channelId);
  }

  /** Disconnect a user from voice (optionally only if they're in that guild). */
  async kick(userId: string, guildId?: string) {
    const s = this.states.get(userId);
    if (!s || (guildId && s.guildId !== guildId)) return;
    await lk.removeParticipant(s.channelId, userId);
    await this.onLeave(userId, s.channelId);
  }

  async closeChannel(channelId: string) {
    for (const uid of this.usersInChannel(channelId)) await this.kick(uid);
    await lk.deleteRoom(channelId);
  }

  /** Voice moderation: server mute / deafen. Enforced by LiveKit permissions. */
  async setServerFlags(guildId: string, userId: string, patch: { mute?: boolean; deaf?: boolean }) {
    const key = `${guildId}:${userId}`;
    const cur = this.serverFlags.get(key) ?? { mute: false, deaf: false };
    const next = { mute: patch.mute ?? cur.mute, deaf: patch.deaf ?? cur.deaf };
    if (!next.mute && !next.deaf) this.serverFlags.delete(key);
    else this.serverFlags.set(key, next);
    const s = this.states.get(userId);
    if (s && s.guildId === guildId) {
      const { rights, canSubscribe } = this.rightsFor(userId, s.channelId);
      await lk.setRights(s.channelId, userId, rights, canSubscribe);
      const upd = { ...s, serverMute: next.mute, serverDeaf: next.deaf };
      this.states.set(userId, upd);
      this.emit(this.dto(upd), s.channelId);
    }
  }

  /** Re-apply LiveKit rights after role/overwrite changes. */
  async refreshRights(guildId: string) {
    for (const s of this.states.values()) {
      if (s.guildId !== guildId) continue;
      if (!cache.can(s.channelId, s.userId, Permission.CONNECT)) {
        await this.kick(s.userId);
        continue;
      }
      const { rights, canSubscribe } = this.rightsFor(s.userId, s.channelId);
      await lk.setRights(s.channelId, s.userId, rights, canSubscribe);
    }
  }

  async move(userId: string, channelId: string | null) {
    const s = this.states.get(userId);
    if (!s) return;
    toUser(userId, "VOICE_MOVE", { channelId });
    if (!channelId) await this.kick(userId);
  }

  /** Client told us what it thinks — verify with LiveKit and fix our view. */
  async verify(userId: string, claimed: string | null) {
    if (claimed) {
      const sid = await lk.getParticipantSid(claimed, userId);
      if (sid) await this.onJoin(userId, claimed, sid);
      return;
    }
    const s = this.states.get(userId);
    if (!s) return;
    const sid = await lk.getParticipantSid(s.channelId, userId);
    if (!sid) await this.onLeave(userId, s.channelId);
  }

  async reconcile() {
    let snap: Awaited<ReturnType<typeof lk.snapshot>>;
    try {
      snap = await lk.snapshot();
      this.failures = 0;
    } catch {
      // LiveKit unreachable for ~1.5 min → nobody can really be connected.
      if (++this.failures >= 3) for (const s of [...this.states.values()]) await this.onLeave(s.userId, s.channelId);
      return;
    }
    for (const [userId, info] of snap) {
      const s = this.states.get(userId);
      if (!s || s.channelId !== info.channelId) await this.onJoin(userId, info.channelId, info.sid, info.joinedAt);
    }
    const now = Date.now();
    for (const s of [...this.states.values()]) {
      if (!snap.has(s.userId) && now - s.joinedAt > JOIN_GRACE_MS) await this.onLeave(s.userId, s.channelId);
    }
  }

  // ── DM calls ──────────────────────────────────────────────────────────────
  private async callJoin(userId: string, channelId: string) {
    const recipients = cache.privates.get(channelId)?.recipients;
    if (!recipients) return;
    let call = this.calls.get(channelId);
    if (!call) {
      const inCall = new Set(this.usersInChannel(channelId));
      call = {
        channelId,
        initiatorId: userId,
        ringing: new Set([...recipients].filter((u) => !inCall.has(u))),
        startedAt: Date.now(),
        everJoined: new Set([userId]),
        ringTimer: null,
        messageId: null,
      };
      this.calls.set(channelId, call);
      this.armRingTimer(call);
      toUsers(recipients, "CALL_CREATE", this.callDto(call));
      await this.pushRing(call, userId);
      try {
        const msg = await createMessage(userId, channelId, { content: "" }, { type: MessageType.CALL, meta: { participants: [userId], endedAt: null, durationSec: null } });
        call.messageId = msg.id;
      } catch {
        /* the call works without its log line */
      }
      return;
    }
    call.everJoined.add(userId);
    const wasRinging = call.ringing.delete(userId);
    if (wasRinging) pushToUser(userId, { type: "call_end", title: "", body: "", channelId });
    toUsers(recipients, "CALL_UPDATE", this.callDto(call));
  }

  private armRingTimer(call: Call) {
    if (call.ringTimer) clearTimeout(call.ringTimer);
    call.ringTimer = setTimeout(() => {
      call.ringTimer = null;
      if (!call.ringing.size) return;
      for (const u of call.ringing) pushToUser(u, { type: "call_end", title: "", body: "", channelId: call.channelId });
      call.ringing.clear();
      const rec = cache.privates.get(call.channelId)?.recipients;
      if (rec) toUsers(rec, "CALL_UPDATE", this.callDto(call));
    }, RING_MS);
    call.ringTimer.unref?.();
  }

  private async pushRing(call: Call, callerId: string) {
    if (!call.ringing.size) return;
    const caller = await prisma.user.findUnique({ where: { id: callerId }, select: { displayName: true, username: true, avatar: true } });
    const name = caller?.displayName || caller?.username || "?";
    for (const u of call.ringing) {
      pushToUser(u, { type: "call", title: name, body: "Входящий звонок", channelId: call.channelId, icon: caller?.avatar ?? null });
    }
  }

  async ring(actorId: string, channelId: string, recipients?: string[]) {
    const rec = cache.privates.get(channelId)?.recipients;
    const call = this.calls.get(channelId);
    if (!rec || !call || !rec.has(actorId)) return;
    const inCall = new Set(this.usersInChannel(channelId));
    for (const u of recipients ?? [...rec]) if (rec.has(u) && !inCall.has(u)) call.ringing.add(u);
    this.armRingTimer(call);
    toUsers(rec, "CALL_UPDATE", this.callDto(call));
    await this.pushRing(call, actorId);
  }

  decline(userId: string, channelId: string) {
    const call = this.calls.get(channelId);
    const rec = cache.privates.get(channelId)?.recipients;
    if (!call || !rec || !call.ringing.delete(userId)) return;
    pushToUser(userId, { type: "call_end", title: "", body: "", channelId });
    toUsers(rec, "CALL_UPDATE", this.callDto(call));
  }

  private async endCall(channelId: string) {
    const call = this.calls.get(channelId);
    if (!call) return;
    this.calls.delete(channelId);
    if (call.ringTimer) clearTimeout(call.ringTimer);
    for (const u of call.ringing) pushToUser(u, { type: "call_end", title: "", body: "", channelId });
    const rec = cache.privates.get(channelId)?.recipients;
    if (rec) toUsers(rec, "CALL_DELETE", { channelId });
    if (!call.messageId) return;
    const durationSec = Math.round((Date.now() - call.startedAt) / 1000);
    await prisma.message
      .update({
        where: { id: call.messageId },
        data: { meta: JSON.stringify({ participants: [...call.everJoined], endedAt: new Date().toISOString(), durationSec, missed: call.everJoined.size < 2 }) },
      })
      .catch(() => {});
    const dto = await loadMessage(call.messageId);
    if (dto) toChannel(channelId, "MESSAGE_UPDATE", dto);
  }
}

export const voice = new VoiceManager();
