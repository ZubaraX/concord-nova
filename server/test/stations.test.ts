import { describe, expect, it } from "vitest";
import { popularStations, searchStations } from "../src/services/stations";

const names = (q: string) => searchStations(q).map((s) => s.name);

describe("the built-in station catalogue (works without reaching Radio Browser)", () => {
  it("popular stations come first, as many as asked", () => {
    const top = popularStations(50);
    expect(top).toHaveLength(50);
    expect(top.every((s) => /^https?:\/\//.test(s.url))).toBe(true);
  });
  it("finds a station whichever script the name and the search are in", () => {
    expect(names("европа")).toContain("Europa Plus");
    expect(names("Europa")).toContain("Europa Plus");
    expect(names("ретро")).toContain("Ретро FM");
    expect(names("retro")).toContain("Ретро FM");
    expect(names("вести фм")).toContain("Вести ФМ (Vesti FM)");
  });
  it("by genre too, and nothing for nonsense", () => {
    expect(searchStations("jazz").length).toBeGreaterThan(0);
    expect(names("zzqqxx")).toEqual([]);
  });
});
