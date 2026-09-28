// ULID: 48-bit millisecond timestamp + 80 bits of randomness, Crockford
// base32, 26 chars. Lexicographic order == creation order, so ids double as
// cursors ("messages before X", "unread if lastMessageId > lastReadId").
// Monotonic within the same millisecond on a single process.

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DEC: Record<string, number> = Object.fromEntries([...ENC].map((c, i) => [c, i]));
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = -1;
let lastRand: number[] = [];

function randomChars(): number[] {
  const bytes = new Uint8Array(RAND_LEN);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b & 31);
}

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENC[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    // Same (or clock-skewed earlier) millisecond: increment the random part so
    // ordering stays strictly monotonic.
    now = lastTime;
    let i = RAND_LEN - 1;
    while (i >= 0 && lastRand[i] === 31) {
      lastRand[i] = 0;
      i--;
    }
    if (i < 0) {
      // 80-bit overflow within one ms — practically impossible; move time on.
      now = lastTime + 1;
      lastTime = now;
      lastRand = randomChars();
    } else {
      lastRand[i]++;
    }
  } else {
    lastTime = now;
    lastRand = randomChars();
  }
  return encodeTime(now) + lastRand.map((n) => ENC[n]).join("");
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(v: unknown): v is string {
  return typeof v === "string" && ULID_RE.test(v);
}

/** Creation time (ms) encoded in a ULID. */
export function ulidTime(id: string): number {
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) t = t * 32 + (DEC[id[i]] ?? 0);
  return t;
}

/** Smallest/largest ULID for a timestamp — cursor helpers for date jumps. */
export function ulidBound(ms: number, upper = false): string {
  return encodeTime(Math.max(0, Math.floor(ms))) + (upper ? "Z" : "0").repeat(RAND_LEN);
}

/** Compare ULIDs (or null) — null sorts first. */
export function compareIds(a: string | null | undefined, b: string | null | undefined): number {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return a < b ? -1 : 1;
}
