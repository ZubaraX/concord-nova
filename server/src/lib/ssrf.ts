// Outbound fetch for user-supplied URLs (link previews). Blocks private,
// loopback, link-local and other internal addresses — and validates the IP the
// socket actually connects to (inside the DNS lookup hook), so DNS rebinding
// can't sneak past a pre-check. Redirects are followed manually and re-checked.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";
import type { LookupFunction } from "node:net";

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => (a << 8) + (Number(o) & 255), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isPrivateV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (!net.isIPv6(ip)) return true;
  const a = ip.toLowerCase();
  if (a === "::" || a === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isPrivateV4(mapped[1]);
  if (/^64:ff9b::/.test(a)) {
    const tail = a.split(":").slice(-2);
    if (tail.length === 2) {
      const hi = parseInt(tail[0] || "0", 16);
      const lo = parseInt(tail[1] || "0", 16);
      return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return true;
  }
  const first = parseInt(a.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (a.startsWith("2001:db8:")) return true; // documentation
  return false;
}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as (e: Error | null, a: string, f: number) => void)(err, "", 4);
    const list = (addresses as unknown as dns.LookupAddress[]).filter((x) => !isPrivateIp(x.address));
    if (!list.length) {
      const e = Object.assign(new Error(`blocked address for ${hostname}`), { code: "EBLOCKED" });
      return (callback as (e: Error | null, a: string, f: number) => void)(e, "", 4);
    }
    if ((options as { all?: boolean }).all) {
      return (callback as unknown as (e: Error | null, a: dns.LookupAddress[]) => void)(null, list);
    }
    (callback as (e: Error | null, a: string, f: number) => void)(null, list[0].address, list[0].family);
  });
};

export interface SafeResponse {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string;
}

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const { timeoutMs = 6000, maxBytes = 1_500_000, maxRedirects = 4, accept = "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.5" } = opts;
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    if (!ALLOWED_PORTS.has(url.port)) throw new Error("port not allowed");
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && isPrivateIp(url.hostname.replace(/^\[|\]$/g, ""))) {
      throw new Error("blocked address");
    }
    const res = await requestOnce(url, timeoutMs, maxBytes, accept);
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = new URL(res.location, url);
      continue;
    }
    return { url: url.toString(), status: res.status, contentType: res.contentType, body: res.body };
  }
  throw new Error("too many redirects");
}

function requestOnce(url: URL, timeoutMs: number, maxBytes: number, accept: string) {
  return new Promise<{ status: number; contentType: string; location?: string; body: Buffer }>((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: safeLookup,
        timeout: timeoutMs,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; ConcordNovaBot/1.0; +link-preview)",
          accept,
          "accept-language": "ru,en;q=0.8",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "");
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, contentType, location: res.headers.location, body: Buffer.alloc(0) });
        }
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            // Enough for metadata — keep what we have and stop downloading.
            chunks.push(c.subarray(0, Math.max(0, c.length - (size - maxBytes))));
            req.destroy();
            resolve({ status, contentType, body: Buffer.concat(chunks) });
            return;
          }
          chunks.push(c);
        });
        stream.on("end", () => resolve({ status, contentType, body: Buffer.concat(chunks) }));
        stream.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}
