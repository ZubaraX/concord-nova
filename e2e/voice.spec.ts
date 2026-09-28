import { expect, test, type Page } from "@playwright/test";
import { api, befriend, guildWith, messageRow, noErrors, openAs, register } from "./helpers";

/**
 * Listens to the remote voice audio actually delivered to this page and
 * reports its channel layout: mono (plays in both ears) or stereo with the
 * energy per side. Guards against "everyone sounds like they're in my left ear".
 */
async function probeRemoteAudio(page: Page) {
  return page.evaluate(async () => {
    const streams = [...document.querySelectorAll("audio")].map((a) => a.srcObject).filter((s): s is MediaStream => s instanceof MediaStream && s.getAudioTracks().length > 0);
    if (!streams.length) return { found: 0, channels: 0, left: 0, right: 0 };
    const ctx = new AudioContext();
    const code = `registerProcessor("probe", class extends AudioWorkletProcessor {
      constructor() { super(); this.n = 0; this.ch = 0; this.e = [0, 0]; }
      process(inputs) {
        const i = inputs[0];
        if (i && i.length) {
          this.ch = Math.max(this.ch, i.length);
          for (let c = 0; c < Math.min(2, i.length); c++) { let s = 0; for (const v of i[c]) s += v * v; this.e[c] += s; }
          if (++this.n % 150 === 0) this.port.postMessage({ ch: this.ch, e: this.e });
        }
        return true;
      }
    });`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    const node = new AudioWorkletNode(ctx, "probe");
    ctx.createMediaStreamSource(streams[0]).connect(node);
    const res = await new Promise<{ ch: number; e: number[] }>((resolve) => {
      let last = { ch: 0, e: [0, 0] };
      node.port.onmessage = (m) => (last = m.data);
      setTimeout(() => resolve(last), 3000);
    });
    await ctx.close();
    return { found: streams.length, channels: res.ch, left: res.e[0], right: res.e[1] };
  });
}

test("voice channel: join, hear each other in both ears, see mute", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, voice } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${voice.id}`);

  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  await b.page.getByRole("button", { name: "Зайти в канал" }).click();

  // Both see both tiles.
  for (const s of [a, b]) {
    await expect(s.page.locator(`[data-user="${alice.id}"]`)).toBeVisible();
    await expect(s.page.locator(`[data-user="${bob.id}"]`)).toBeVisible();
  }
  // The fake microphone beeps: Bob sees Alice speaking — audio really flows.
  await expect(b.page.locator(`[data-user="${alice.id}"] [data-speaking="true"]`)).toBeVisible({ timeout: 20_000 });

  // Delivered audio is mono or balanced stereo (never one-sided).
  const probe = await probeRemoteAudio(b.page);
  expect(probe.found, "no remote audio element").toBeGreaterThan(0);
  if (probe.channels >= 2) expect(probe.right, JSON.stringify(probe)).toBeGreaterThan(probe.left * 0.25);

  // Alice mutes → Bob sees the crossed-out mic on her tile.
  await a.page.getByRole("button", { name: "Выключить микрофон" }).first().click();
  await expect(b.page.locator(`[data-user="${alice.id}"] svg.lucide-mic-off`)).toBeVisible();

  await a.page.getByRole("button", { name: "Отключиться" }).first().click();
  await expect(b.page.locator(`[data-user="${alice.id}"]`)).toHaveCount(0);
  noErrors(a, b);
});

test("DM call: ring, answer, hang up, call log line", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  await befriend(request, alice, bob);
  const dm = await api<{ id: string }>(request, alice, "POST", "/api/users/@me/channels", { recipientId: bob.id });
  const a = await openAs(browser, alice, `/#/channels/@me/${dm.id}`);
  const b = await openAs(browser, bob, "/#/channels/@me");

  await a.page.getByRole("button", { name: "Позвонить" }).first().click();
  await expect(b.page.getByText("Входящий звонок")).toBeVisible();
  await b.page.getByRole("button", { name: "Ответить", exact: true }).click();

  for (const s of [a, b]) {
    await expect(s.page.locator(`[data-user="${alice.id}"]`)).toBeVisible();
    await expect(s.page.locator(`[data-user="${bob.id}"]`)).toBeVisible();
  }
  await a.page.getByRole("button", { name: "Отключиться" }).first().click();
  await b.page.getByRole("button", { name: "Отключиться" }).first().click();
  await expect(messageRow(a.page, "Звонок")).toBeVisible();
  noErrors(a, b);
});
