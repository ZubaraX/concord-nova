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
  // Alice sends the fake microphone's beeps untouched: a denoiser may (rightly) treat them as noise.
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`, { local: { noise: "off" } });
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

  // The strong denoiser (DeepFilterNet3, shipped with the app) really loaded — no silent fallback.
  await expect(b.page.getByRole("button", { name: "Шумоподавление" })).toHaveAttribute("data-denoiser", "deep", { timeout: 20_000 });
  await expect(a.page.getByRole("button", { name: "Шумоподавление" })).toHaveAttribute("data-denoiser", "none");

  // Connection info: live latency, a one-minute chart with a hover readout.
  await b.page.getByRole("button", { name: "Сведения о подключении" }).last().click();
  const info = b.page.locator("[data-connection-stats]");
  await expect(info).toContainText(/Задержка\s*\d+ мс/, { timeout: 15_000 });
  const chart = info.getByRole("img");
  await expect(chart).toBeVisible();
  const cb = (await chart.boundingBox())!;
  await b.page.mouse.move(cb.x + cb.width - 20, cb.y + cb.height / 2);
  await expect(info).toContainText(/\d+ мс · (сейчас|\d+ с назад)/);
  await info.getByRole("button", { name: "Потери" }).click();
  await expect(info).toContainText("Потери пакетов за минуту");
  await b.page.keyboard.press("Escape");
  await expect(info).toHaveCount(0);

  // Mute for yourself: a mark on the tile; the same menu item takes it back.
  const aliceTile = b.page.locator(`[data-user="${alice.id}"]`);
  await aliceTile.click({ button: "right" });
  await b.page.getByRole("menuitem", { name: "Заглушить для себя" }).click();
  await expect(aliceTile.getByTitle("Заглушён для вас")).toBeVisible();
  await aliceTile.click({ button: "right" });
  await b.page.getByRole("menuitem", { name: "Вернуть звук для себя" }).click();
  await expect(aliceTile.getByTitle("Заглушён для вас")).toHaveCount(0);

  // Voice changer: switching the effect mid-call keeps the audio flowing.
  await a.page.getByRole("button", { name: "Изменение голоса" }).click();
  await a.page.getByRole("menuitem", { name: "Робот" }).click();
  await expect(b.page.locator(`[data-user="${alice.id}"] [data-speaking="true"]`)).toBeVisible({ timeout: 20_000 });
  await a.page.getByRole("button", { name: "Изменение голоса" }).click();
  await a.page.getByRole("menuitem", { name: "Обычный голос" }).click();

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
  // While it rings, the caller sees who is being called.
  await expect(a.page.locator(`[data-ringing="${bob.id}"]`)).toContainText("Звоним");
  await expect(b.page.getByText("Входящий звонок")).toBeVisible();
  await b.page.getByRole("button", { name: "Ответить", exact: true }).click();
  await expect(a.page.locator(`[data-ringing="${bob.id}"]`)).toHaveCount(0);

  for (const s of [a, b]) {
    await expect(s.page.locator(`[data-user="${alice.id}"]`)).toBeVisible();
    await expect(s.page.locator(`[data-user="${bob.id}"]`)).toBeVisible();
    // The call panel above the chat really has room: tiles are visible and the
    // controls sit inside it, below the channel header (they once collapsed onto it).
    await expect.poll(async () => (await s.page.locator(`[data-user="${bob.id}"]`).boundingBox())?.height ?? 0).toBeGreaterThan(80);
    const header = (await s.page.locator("header").first().boundingBox())!;
    const controls = (await s.page.getByRole("button", { name: "Отключиться" }).last().boundingBox())!;
    expect(controls.y, "call controls below the header").toBeGreaterThan(header.y + header.height);
  }
  await expect(a.page.getByRole("button", { name: "Во весь экран" })).toBeVisible();
  // Already in the call: the call line in the chat doesn't offer to join it.
  await expect(a.page.getByRole("button", { name: "Присоединиться" })).toHaveCount(0);
  await a.page.getByRole("button", { name: "Отключиться" }).first().click();
  await b.page.getByRole("button", { name: "Отключиться" }).first().click();
  await expect(messageRow(a.page, "Звонок")).toBeVisible();
  noErrors(a, b);
});

test("an empty call ends by itself; Stay and the setting keep it", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, voice } = await guildWith(request, alice, [bob]);
  // The real limit is a minute; ten seconds here (the warning then comes at once).
  const quick = { storage: { "nova.test.aloneMs": "10000" } };
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`, quick);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${voice.id}`, { ...quick, local: { noise: "off" } });
  const countdown = a.page.locator("[data-alone-countdown]");
  const hangUp = a.page.getByRole("button", { name: "Отключиться" });

  // Alone from the start: the countdown runs, "Stay" stops it.
  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  await expect(countdown).toContainText("Никого нет");
  await countdown.getByRole("button", { name: "Остаться" }).click();
  await expect(countdown).toHaveCount(0);

  // Somebody came and left: the count starts again, and this time nobody stops it.
  await b.page.getByRole("button", { name: "Зайти в канал" }).click();
  await expect(a.page.locator(`[data-user="${bob.id}"]`)).toBeVisible();
  // Really in the call (not just on the way in): Alice hears Bob's fake microphone.
  await expect(b.page.getByText("Голосовая связь")).toBeVisible();
  await expect(a.page.locator(`[data-user="${bob.id}"] [data-speaking="true"]`)).toBeVisible({ timeout: 20_000 });
  await expect(countdown).toHaveCount(0);
  await b.page.getByRole("button", { name: "Отключиться" }).first().click();
  await expect(countdown).toBeVisible();
  await expect(a.page.getByText("В звонке никого нет. Отключение через 10 секунд.").last()).toBeVisible();
  await expect(a.page.getByText(/Звонок завершён/)).toBeVisible({ timeout: 15_000 });
  await expect(hangUp).toHaveCount(0);
  // Bob sees the channel empty too — the server was told.
  await expect(b.page.locator(`[data-user="${alice.id}"]`)).toHaveCount(0);

  // "DM calls only": a server channel is left alone.
  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  await expect(countdown).toBeVisible();
  await a.page.getByRole("button", { name: "Настройки" }).last().click();
  await a.page.locator("[data-settings] nav").getByRole("button", { name: "Голос и видео", exact: true }).click();
  await a.page.getByRole("button", { name: "Только личные", exact: true }).click();
  await a.page.keyboard.press("Escape");
  await expect(a.page.locator("[data-settings]")).toHaveCount(0);
  await expect(countdown).toHaveCount(0);
  await a.page.waitForTimeout(11_000);
  await expect(hangUp.first()).toBeVisible();
  await expect(a.page.locator(`[data-user="${alice.id}"]`).first()).toBeVisible();
  noErrors(a, b);
});

test("voice changer: every effect produces sound, pitch effects move the pitch", async ({ browser, request }) => {
  const s = await openAs(browser, await register(request, "Голос"));
  const res = await s.page.evaluate(async () => {
    const { VOICE_EFFECTS, buildEffect } = await import("/src/features/voice/effects.ts" as string);
    const out: Record<string, { rms: number; hz: number; finite: boolean }> = {};
    for (const e of VOICE_EFFECTS as string[]) {
      const sr = 48_000;
      const ctx = new OfflineAudioContext(1, sr * 2, sr);
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 200;
      const fx = buildEffect(ctx, e);
      osc.connect(fx.input);
      fx.output.connect(ctx.destination);
      osc.start();
      const d = (await ctx.startRendering()).getChannelData(0);
      let sum = 0;
      for (let i = sr; i < sr * 2; i++) sum += d[i] * d[i];
      // Fundamental by autocorrelation (100–500 Hz) over the last second.
      let best = -Infinity;
      let lag = 0;
      for (let l = 96; l <= 480; l++) {
        let c = 0;
        for (let i = sr; i < sr * 2 - l; i += 2) c += d[i] * d[i + l];
        if (c > best) {
          best = c;
          lag = l;
        }
      }
      out[e] = { rms: Math.sqrt(sum / sr), hz: Math.round(sr / lag), finite: d.every(Number.isFinite) };
    }
    return out;
  });
  for (const [name, r] of Object.entries(res)) {
    expect(r.finite, name).toBe(true);
    expect(r.rms, name).toBeGreaterThan(0.01);
  }
  // A 200 Hz tone: the chipmunk raises it, the giant lowers it.
  expect(res.none.hz).toBe(200);
  expect(res.high.hz, JSON.stringify(res.high)).toBeGreaterThan(260);
  expect(res.low.hz, JSON.stringify(res.low)).toBeLessThan(165);
  noErrors(s);
});
