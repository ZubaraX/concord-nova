// LiveKit (self-hosted SFU) integration: join tokens scoped by channel
// permissions, the room service for moderation, and webhook verification.
// One LiveKit room per voice/DM channel: `ch_<channelId>`; identity = user id,
// so the same account joining from a second device replaces the first.
import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from "livekit-server-sdk";
import { config, voiceEnabled } from "../config";

export const roomName = (channelId: string) => `ch_${channelId}`;
export const channelFromRoom = (room: string | undefined | null) => (room && room.startsWith("ch_") ? room.slice(3) : null);

let svc: RoomServiceClient | null = null;
export function rooms(): RoomServiceClient | null {
  if (!voiceEnabled()) return null;
  if (!svc) svc = new RoomServiceClient(config.livekit.internalUrl, config.livekit.apiKey, config.livekit.apiSecret);
  return svc;
}

let receiver: WebhookReceiver | null = null;
export function webhookReceiver(): WebhookReceiver | null {
  if (!voiceEnabled()) return null;
  if (!receiver) receiver = new WebhookReceiver(config.livekit.apiKey, config.livekit.apiSecret);
  return receiver;
}

export interface PublishRights {
  mic: boolean;
  camera: boolean;
  screen: boolean;
}

export function sourcesFor(r: PublishRights): TrackSource[] {
  const out: TrackSource[] = [];
  if (r.mic) out.push(TrackSource.MICROPHONE);
  if (r.camera) out.push(TrackSource.CAMERA);
  if (r.screen) out.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  return out;
}

export async function joinToken(opts: {
  userId: string;
  name: string;
  avatar: string | null;
  channelId: string;
  rights: PublishRights;
  canSubscribe: boolean;
}): Promise<string> {
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: opts.userId,
    name: opts.name,
    metadata: JSON.stringify({ avatar: opts.avatar }),
    ttl: "6h",
  });
  at.addGrant({
    roomJoin: true,
    room: roomName(opts.channelId),
    canPublish: opts.rights.mic || opts.rights.camera || opts.rights.screen,
    canPublishSources: sourcesFor(opts.rights),
    canSubscribe: opts.canSubscribe,
    canPublishData: true,
    canUpdateOwnMetadata: false,
  });
  return at.toJwt();
}

export async function removeParticipant(channelId: string, userId: string) {
  const r = rooms();
  if (!r) return;
  try {
    await r.removeParticipant(roomName(channelId), userId);
  } catch {
    /* not in the room (already gone) */
  }
}

export async function setRights(channelId: string, userId: string, rights: PublishRights, canSubscribe: boolean) {
  const r = rooms();
  if (!r) return;
  try {
    await r.updateParticipant(roomName(channelId), userId, {
      permission: {
        canPublish: rights.mic || rights.camera || rights.screen,
        canPublishSources: sourcesFor(rights),
        canSubscribe,
        canPublishData: true,
      },
    });
  } catch {
    /* participant left meanwhile */
  }
}

export async function getParticipantSid(channelId: string, userId: string): Promise<string | null> {
  const r = rooms();
  if (!r) return null;
  try {
    const p = await r.getParticipant(roomName(channelId), userId);
    return p.sid;
  } catch {
    return null;
  }
}

export async function deleteRoom(channelId: string) {
  const r = rooms();
  if (!r) return;
  try {
    await r.deleteRoom(roomName(channelId));
  } catch {
    /* no such room */
  }
}

/** Everyone currently in any of our rooms: userId → { channelId, sid, joinedAt }. */
export async function snapshot(): Promise<Map<string, { channelId: string; sid: string; joinedAt: number }>> {
  const r = rooms();
  const out = new Map<string, { channelId: string; sid: string; joinedAt: number }>();
  if (!r) return out;
  const list = await r.listRooms();
  for (const room of list) {
    const channelId = channelFromRoom(room.name);
    if (!channelId || !room.numParticipants) continue;
    const parts = await r.listParticipants(room.name);
    for (const p of parts) out.set(p.identity, { channelId, sid: p.sid, joinedAt: Number(p.joinedAt) * 1000 || Date.now() });
  }
  return out;
}
