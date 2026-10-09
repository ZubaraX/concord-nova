import { describe, expect, it } from "vitest";
import { stationPlayUrl, verifyRelay } from "../src/lib/radioRelay";

describe("FM relay addresses", () => {
  it("https streams play directly; http ones through a signed relay address", () => {
    expect(stationPlayUrl("https://icecast.anon.fm/radio")).toBe("https://icecast.anon.fm/radio");
    const p = stationPlayUrl("http://ep256.hostingradio.ru:8052/europaplus256.mp3");
    expect(p).toMatch(/^\/api\/radio\/relay\?u=[\w-]+&s=[\w-]+$/);
    const q = new URLSearchParams(p.split("?")[1]);
    expect(verifyRelay(q.get("u")!, q.get("s")!)).toBe("http://ep256.hostingradio.ru:8052/europaplus256.mp3");
  });
  it("a forged signature, or one made for the image proxy, doesn't open the relay", () => {
    const u = Buffer.from("http://evil.example/x.mp3").toString("base64url");
    expect(verifyRelay(u, "AAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
  });
});
