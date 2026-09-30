import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerInfoDTO } from "@nova/shared";
import { config, voiceEnabled } from "../config";
import { mailEnabled } from "../lib/mail";
import { instance } from "./instance";

/** Build id of the served web client (written by the client build), read once per server start. */
const webBuild: string | null = (() => {
  try {
    return (JSON.parse(readFileSync(join(config.webDist, "build.json"), "utf8")) as { id?: string }).id ?? null;
  } catch {
    return null;
  }
})();

export function serverInfo(): ServerInfoDTO {
  return {
    name: instance.serverName,
    version: config.version,
    voice: { enabled: voiceEnabled(), url: config.livekit.publicUrl || null },
    gifs: !!instance.gifKey,
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    maxMessageLength: config.MAX_MESSAGE_LENGTH,
    registration: instance.registration,
    mail: mailEnabled,
    webBuild,
    downloads: { windows: config.DOWNLOAD_WINDOWS_URL || null, android: config.DOWNLOAD_ANDROID_URL || null },
  };
}
