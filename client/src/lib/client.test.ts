import { describe, expect, it } from "vitest";
import { ru } from "./i18n/ru";
import { en } from "./i18n/en";
import { pluralIndex, t } from "./i18n";
import { inviteCodeFromUrl, normalizeServer } from "./server";

type Tree = { [k: string]: string | readonly string[] | Tree };
const leaves = (o: Tree, p = ""): [string, string | readonly string[]][] =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === "object" && !Array.isArray(v) ? leaves(v as Tree, `${p}${k}.`) : [[`${p}${k}`, v as string]]));
const vars = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

describe("i18n", () => {
  const ruLeaves = new Map(leaves(ru as unknown as Tree));
  const enLeaves = new Map(leaves(en as unknown as Tree));

  it("English covers every Russian key", () => {
    expect([...ruLeaves.keys()].filter((k) => !enLeaves.has(k))).toEqual([]);
  });

  it("translations keep the same {placeholders}", () => {
    const broken: string[] = [];
    for (const [k, r] of ruLeaves) {
      const e = enLeaves.get(k);
      if (typeof r !== "string" || typeof e !== "string" || !e) continue;
      if (vars(r).join() !== vars(e).join()) broken.push(`${k}: ${vars(r)} ≠ ${vars(e)}`);
    }
    expect(broken).toEqual([]);
  });

  it("plural strings stay plural (ru: 3 forms, en: 2)", () => {
    const broken: string[] = [];
    for (const [k, r] of ruLeaves) {
      const e = enLeaves.get(k);
      if (typeof r !== "string" || typeof e !== "string" || !r.includes("{n}") || !r.includes("|")) continue;
      // joinVariants is a list of alternatives, not plural forms.
      if (k.endsWith("joinVariants")) continue;
      if (r.split("|").length !== 3 || e.split("|").length !== 2) broken.push(k);
    }
    expect(broken).toEqual([]);
  });

  it("tuple entries keep their shape", () => {
    for (const [k, r] of ruLeaves) {
      if (Array.isArray(r)) expect((enLeaves.get(k) as readonly string[]).length, k).toBe(r.length);
    }
  });

  it("Russian plural rules", () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25, 111, 101].map((n) => pluralIndex(n, "ru"))).toEqual([0, 1, 2, 2, 2, 0, 1, 2, 2, 0]);
    expect([0, 1, 2].map((n) => pluralIndex(n, "en"))).toEqual([1, 0, 1]);
  });

  it("interpolates and picks plural forms", () => {
    const s = t("guild.memberCount", { n: 3 });
    expect(s).toMatch(/^3 /);
    expect(t("no.such.key")).toBe("no.such.key");
  });
});

describe("server address", () => {
  it("normalizes what people type", () => {
    expect(normalizeServer("chat.example.com/")).toBe("https://chat.example.com");
    expect(normalizeServer("138.16.224.172")).toBe("http://138.16.224.172");
    expect(normalizeServer("localhost:4000")).toBe("http://localhost:4000");
    expect(normalizeServer("  https://x.io//  ")).toBe("https://x.io");
    expect(normalizeServer("")).toBe("");
  });

  it("recognizes invite links to this server (joined in the app, not in a browser)", () => {
    const own = ["138-16-224-172.sslip.io", "138.16.224.172"];
    expect(inviteCodeFromUrl("https://138-16-224-172.sslip.io/invite/AbC-12", own)).toBe("AbC-12");
    expect(inviteCodeFromUrl("https://138-16-224-172.sslip.io/invite/AbC-12/", own)).toBe("AbC-12");
    expect(inviteCodeFromUrl("https://138-16-224-172.sslip.io/#/invite/xyz", own)).toBe("xyz");
    expect(inviteCodeFromUrl("http://138.16.224.172/invite/xyz?utm=1", own)).toBe("xyz");
    expect(inviteCodeFromUrl("https://example.com/invite/xyz", own)).toBeNull();
    expect(inviteCodeFromUrl("https://138-16-224-172.sslip.io/files/invite/xyz", own)).toBeNull();
    expect(inviteCodeFromUrl("not a url", own)).toBeNull();
  });
});
