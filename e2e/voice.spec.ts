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

test("voice effects: none is much louder than the plain voice; an own effect is saved for the server and others can pick it", async ({ browser, request }) => {
  test.skip(!!process.env.E2E_URL, "imports modules through the dev server");
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice);
  const b = await openAs(browser, bob);
  const openVoiceSettings = async (page: Page) => {
    await page.getByRole("button", { name: "Настройки" }).last().click();
    await page.locator("[data-settings] nav").getByRole("button", { name: "Голос и видео", exact: true }).click();
  };

  // Alice builds one: lower, a bit of drive and reverb — for the server.
  await openVoiceSettings(a.page);
  await a.page.locator('[data-preset-group="mine"]').getByRole("button", { name: "Свой эффект" }).click();
  const editor = a.page.getByRole("dialog").last();
  await editor.getByPlaceholder("Мой голос").fill("Бас");
  const ranges = editor.locator('input[type="range"]');
  await ranges.nth(0).fill("-7"); // pitch
  await ranges.nth(3).fill("0.6"); // drive
  await ranges.nth(8).fill("0.4"); // reverb
  await expect(ranges.nth(0)).toHaveAttribute("aria-valuetext", "-7");
  await editor.getByLabel("Где сохранить").selectOption(guild.id);
  await editor.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const tile = (page: Page) => page.locator(`[data-preset-group="${guild.id}"] [data-preset]`).filter({ hasText: "Бас" });
  await expect(tile(a.page)).toHaveAttribute("aria-pressed", "true"); // a new effect is put on at once

  // Bob sees it under the server, can use it but not change it.
  await openVoiceSettings(b.page);
  await tile(b.page).click();
  await expect(tile(b.page)).toHaveAttribute("aria-pressed", "true");
  await expect(b.page.getByRole("button", { name: "Изменить: Бас" })).toHaveCount(0);

  // Loudness, measured in Bob's app: every built-in and the shared one sit near the plain voice.
  const presetId = await tile(b.page).getAttribute("data-preset");
  const levels = await b.page.evaluate(async (id) => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/features/voice/effects.ts")) ?? "/src/features/voice/effects.ts";
    const m = (await import(/* @vite-ignore */ url)) as {
      VOICE_EFFECTS: readonly string[];
      buildEffect: (c: BaseAudioContext, e: string) => unknown;
      effectGainDb: (build: (c: BaseAudioContext) => unknown) => Promise<number>;
    };
    const out: Record<string, number> = {};
    for (const e of [...m.VOICE_EFFECTS, `custom:${id}`]) out[e] = Math.round((await m.effectGainDb((c) => m.buildEffect(c, e))) * 10) / 10;
    return out;
  }, presetId);
  for (const [effect, db] of Object.entries(levels)) {
    expect(Math.abs(db), `${effect}: ${db} dB against the plain voice`).toBeLessThan(3.5);
  }
  noErrors(a, b);
});

test("mic check in settings keeps the call from hearing it; hotkeys are rare combinations", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, voice } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`, { local: { noise: "off" } });
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${voice.id}`);
  const aliceSpeaks = b.page.locator(`[data-user="${alice.id}"] [data-speaking="true"]`);
  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  await b.page.getByRole("button", { name: "Зайти в канал" }).click();
  await expect(aliceSpeaks).toBeVisible({ timeout: 20_000 });

  // The check plays her voice back to her only.
  await a.page.getByRole("button", { name: "Настройки" }).last().click();
  await a.page.locator("[data-settings] nav").getByRole("button", { name: "Голос и видео", exact: true }).click();
  await a.page.getByRole("button", { name: "Проверить", exact: true }).click();
  await expect(a.page.getByText("Пока идёт проверка, собеседники в звонке вас не слышат.").first()).toBeVisible();
  // (Bob's indicator is redrawn per animation frame: keep his window in front while looking at it.)
  await b.page.bringToFront();
  await expect(aliceSpeaks).toHaveCount(0, { timeout: 15_000 });
  await a.page.bringToFront();
  await a.page.getByRole("button", { name: "Остановить", exact: true }).click();
  await b.page.bringToFront();
  await expect(aliceSpeaks).toBeVisible({ timeout: 20_000 });
  await a.page.bringToFront();
  await a.page.keyboard.press("Escape");
  await expect(a.page.locator("[data-settings]")).toHaveCount(0);

  // Ctrl+Shift+M (often taken in games) does nothing now; Ctrl+Shift+Alt+M mutes.
  const muteButton = a.page.getByRole("button", { name: "Включить микрофон" });
  await a.page.keyboard.press("Control+Shift+KeyM");
  await expect(muteButton).toHaveCount(0);
  await a.page.keyboard.press("Control+Shift+Alt+KeyM");
  await expect(muteButton.first()).toBeVisible();
  await a.page.keyboard.press("Control+Shift+Alt+KeyM");
  await expect(muteButton).toHaveCount(0);
  noErrors(a, b);
});

test("server notifications: every message by default, chosen per server; a call opened in a voice channel is announced", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, voice, text } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${text.id}`);

  // The server's menu: "Notifications ›" opens in place, every message is the default.
  const nav = b.page.getByRole("button", { name: `E2E ${alice.displayName}` }).first();
  await nav.click({ button: "right" });
  await b.page.getByRole("menuitem", { name: "Уведомления", exact: true }).click();
  await expect(b.page.getByRole("menuitem", { name: "Все сообщения" })).toHaveAttribute("data-checked", "true");
  await b.page.getByRole("menuitem", { name: "Только упоминания" }).click();
  await expect.poll(async () => ((await api<{ targetId: string; level: string }[]>(request, bob, "GET", "/api/users/@me/notification-settings")).find((x) => x.targetId === guild.id)?.level)).toBe("mentions");
  await nav.click({ button: "right" });
  await b.page.getByRole("menuitem", { name: "Уведомления", exact: true }).click();
  await b.page.getByRole("menuitem", { name: "Все сообщения" }).click();
  await expect.poll(async () => ((await api<{ targetId: string; level: string }[]>(request, bob, "GET", "/api/users/@me/notification-settings")).find((x) => x.targetId === guild.id)?.level)).toBe("all");

  // Alice opens a call: Bob is told, and joins from the toast.
  await b.page.bringToFront();
  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  const toastJoin = b.page.getByRole("button", { name: "Присоединиться" });
  await expect(b.page.getByText(/Алиса начал\(а\) звонок/)).toBeVisible({ timeout: 15_000 });
  await toastJoin.click();
  await expect(b.page.getByRole("button", { name: "Отключиться" }).first()).toBeVisible({ timeout: 20_000 });
  noErrors(a, b);
});
