import type { ServerInfoDTO } from "@nova/shared";
import { config, voiceEnabled } from "../config";
import { mailEnabled } from "../lib/mail";

export function serverInfo(): ServerInfoDTO {
  return {
    name: config.SERVER_NAME,
    version: config.version,
    voice: { enabled: voiceEnabled(), url: config.livekit.publicUrl || null },
    gifs: !!(config.KLIPY_KEY || config.TENOR_KEY),
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    maxMessageLength: config.MAX_MESSAGE_LENGTH,
    registration: config.REGISTRATION,
    mail: mailEnabled,
  };
}
