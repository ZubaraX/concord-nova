import { expect, test } from "@playwright/test";
import { api, befriend, guildWith, messageRow, noErrors, openAs, register, run, send } from "./helpers";

test("roles: create a role, give it to a member, kick them", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, text } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${text.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${text.id}`);

  // Server settings → Roles → new role, rename, save.
  await a.page.getByText(guild.name).first().click();
  await a.page.getByRole("menuitem", { name: "Настройки сервера" }).click();
  await a.page.getByRole("button", { name: "Роли", exact: true }).click();
  await a.page.getByRole("button", { name: /Новая роль/ }).click();
  const roleName = a.page.getByLabel("Название роли");
  await roleName.fill(`Модератор ${run}`);
  await a.page.getByRole("button", { name: /Сохранить/ }).last().click();
  await a.page.keyboard.press("Escape");

  // Give it to Bob from his profile; his name takes the role everywhere.
  await a.page.getByText("Боб").last().click({ button: "right" });
  await a.page.getByRole("menuitem", { name: "Открыть профиль" }).click();
  await a.page.getByRole("button", { name: "Добавить роль" }).click();
  await a.page.getByRole("menuitem", { name: `Модератор ${run}` }).click();
  await expect(a.page.getByRole("dialog").getByText(`Модератор ${run}`)).toBeVisible();
  await a.page.keyboard.press("Escape");

  // Kick: Bob loses the server live.
  await a.page.getByText("Боб").last().click({ button: "right" });
  await a.page.getByRole("menuitem", { name: "Выгнать" }).click();
  await a.page.getByRole("button", { name: /Выгнать|Подтвердить/ }).last().click();
  await expect(b.page.getByText(guild.name)).toHaveCount(0);
  noErrors(a, b);
});

test("threads, polls, pins panel and search", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, text } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${text.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${text.id}`);

  // Thread from a message.
  await send(a.page, `Обсудим план ${run}`);
  await messageRow(a.page, `Обсудим план ${run}`).click({ button: "right" });
  await a.page.getByRole("menuitem", { name: "Создать ветку" }).click();
  await send(a.page, "Первый пункт в ветке");
  // Bob sees the thread chip under the message, with the reply count.
  await expect(messageRow(b.page, `Обсудим план ${run}`).getByText(/1 ответ/)).toBeVisible();

  // Poll: Alice asks, Bob votes, Alice sees the vote.
  await a.page.goto(`/#/channels/${guild.id}/${text.id}`);
  await a.page.getByRole("button", { name: "Файлы и другое" }).first().click();
  await a.page.getByRole("menuitem", { name: "Опрос" }).click();
  await a.page.getByLabel("Вопрос").fill(`Пицца или суши ${run}?`);
  await a.page.getByPlaceholder("Вариант 1").fill("Пицца");
  await a.page.getByPlaceholder("Вариант 2").fill("Суши");
  await a.page.getByRole("dialog").getByRole("button", { name: "Создать", exact: true }).click();
  const pollOnB = messageRow(b.page, `Пицца или суши ${run}?`);
  await expect(pollOnB).toBeVisible();
  await pollOnB.getByText("Пицца", { exact: true }).click();
  // single choice: a click is the vote
  await expect(messageRow(a.page, `Пицца или суши ${run}?`).getByText(/1 голос/)).toBeVisible();

  // Search finds the thread starter.
  await a.page.getByRole("button", { name: "Поиск" }).first().click();
  await a.page.getByPlaceholder(/Искать/).fill(`план ${run}`);
  await a.page.keyboard.press("Enter");
  await expect(a.page.getByText(/1 результат/)).toBeVisible();
  noErrors(a, b);
});

test("camera and screen share reach the other side", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, voice } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${voice.id}`);
  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  await b.page.getByRole("button", { name: "Зайти в канал" }).click();
  await expect(b.page.locator(`[data-user="${alice.id}"]`).first()).toBeVisible();

  await a.page.getByRole("button", { name: "Включить камеру" }).first().click();
  await expect(b.page.locator(`[data-user="${alice.id}"][data-source="camera"] video`)).toBeVisible({ timeout: 20_000 });

  await a.page.getByRole("button", { name: "Показать экран" }).first().click();
  const stream = b.page.locator(`[data-user="${alice.id}"][data-source="screen"]`);
  await expect(stream).toBeVisible({ timeout: 20_000 });
  // Not opened by itself: nothing is downloaded until Bob chooses to watch.
  await expect(stream.locator("[data-stream-offer]")).toContainText("показывает экран");
  await expect(stream.locator("video")).toHaveCount(0);
  await stream.getByRole("button", { name: "Смотреть трансляцию" }).click();
  await expect(stream.locator("video")).toBeVisible({ timeout: 20_000 });
  await stream.hover();
  await expect(stream.getByRole("button", { name: "Во весь экран" })).toBeVisible();
  await a.page.getByRole("button", { name: "Отключиться" }).first().click();
  noErrors(a, b);
});

test("group DM with two friends", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const cat = await register(request, "Катя");
  await befriend(request, alice, bob);
  await befriend(request, alice, cat);
  const group = await api<{ id: string }>(request, alice, "POST", "/api/users/@me/channels", { recipients: [bob.id, cat.id] });
  const a = await openAs(browser, alice, `/#/channels/@me/${group.id}`);
  const c = await openAs(browser, cat, "/#/channels/@me");
  await send(a.page, "Всем привет в группе");
  await c.page.getByText(/Алиса|Боб/).first().click();
  await expect(messageRow(c.page, "Всем привет в группе")).toBeVisible();
  noErrors(a, c);
});

test("profile edits show up for others", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, text } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${text.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${text.id}`);
  await a.page.getByRole("button", { name: "Настройки" }).last().click();
  await a.page.getByRole("button", { name: "Профиль", exact: true }).click();
  await a.page.getByLabel("Отображаемое имя").fill(`Алиса Новая ${run}`);
  await a.page.getByLabel("Обо мне").fill("Люблю тесты");
  await a.page.getByRole("button", { name: /Сохранить/ }).last().click();
  await a.page.keyboard.press("Escape");
  await expect(b.page.getByText(`Алиса Новая ${run}`).first()).toBeVisible();
  noErrors(a, b);
});

test("windows app: screen-share audio comes from the helper (without Nova's own sound) and stops with the share", async ({ browser, request }) => {
  test.skip(!!process.env.E2E_URL, "imports modules through the dev server");
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, voice } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`, { desktop: true });
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${voice.id}`);
  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  await b.page.getByRole("button", { name: "Зайти в канал" }).click();
  await expect(b.page.locator(`[data-user="${alice.id}"]`).first()).toBeVisible();

  // What the desktop shell does once the helper is ready: "start", then a stream of 48 kHz stereo PCM (a 440 Hz tone here).
  await a.page.evaluate(() => {
    const send = (window as unknown as { __appAudio: (k: string, pcm?: Uint8Array) => void }).__appAudio;
    send("start");
    let phase = 0;
    setInterval(() => {
      const frames = 960;
      const pcm = new Int16Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        const v = Math.round(Math.sin(phase) * 9000);
        pcm[2 * i] = v;
        pcm[2 * i + 1] = v;
        phase += (2 * Math.PI * 440) / 48000;
      }
      send("pcm", new Uint8Array(pcm.buffer));
    }, 20);
  });
  await a.page.getByRole("button", { name: "Показать экран" }).first().click();
  await b.page.locator(`[data-user="${alice.id}"][data-source="screen"]`).getByRole("button", { name: "Смотреть трансляцию" }).click();
  await expect(b.page.locator(`[data-user="${alice.id}"][data-source="screen"] video`)).toBeVisible({ timeout: 20_000 });

  const level = () =>
    b.page.evaluate(async (aliceId) => {
      // The very module instance the app runs (Vite may have added ?t= to its URL).
      const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/features/voice/voice.ts")) ?? "/src/features/voice/voice.ts";
      const m = (await import(/* @vite-ignore */ url)) as { getRoom: () => import("livekit-client").Room | null };
      const pub = m.getRoom()?.remoteParticipants.get(aliceId)?.getTrackPublication("screen_share_audio" as never);
      const track = pub?.track?.mediaStreamTrack;
      if (!track) return { name: pub?.trackName ?? null, db: -200 };
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      ctx.createMediaStreamSource(new MediaStream([track])).connect(an);
      const buf = new Float32Array(an.fftSize);
      let peak = 0;
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 100));
        an.getFloatTimeDomainData(buf);
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
      }
      await ctx.close();
      return { name: pub?.trackName ?? null, db: Math.round(20 * Math.log10(peak + 1e-9)) };
    }, alice.id);
  await expect.poll(async () => (await level()).name, { timeout: 15_000 }).toBe("screen-audio-app");
  await expect.poll(async () => (await level()).db, { timeout: 15_000 }).toBeGreaterThan(-30);

  // Stopping the share stops the helper and takes the audio away.
  await a.page.getByRole("button", { name: "Остановить показ" }).first().click();
  await expect.poll(() => a.page.evaluate(() => (window as unknown as { __appAudioStops?: number }).__appAudioStops ?? 0)).toBeGreaterThan(0);
  await expect.poll(async () => (await level()).name, { timeout: 15_000 }).toBeNull();
  noErrors(a, b);
});

test("streams open only on request and each one's sound can be muted; soundboard sounds have a volume on the listener's side", async ({ browser, request }) => {
  test.skip(!!process.env.E2E_URL, "imports modules through the dev server");
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, voice } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${voice.id}`);
  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  await b.page.getByRole("button", { name: "Зайти в канал" }).click();
  await expect(b.page.locator(`[data-user="${alice.id}"]`).first()).toBeVisible();

  /** What Bob's app has subscribed to from Alice, and how loud it plays. */
  const fromAlice = () =>
    b.page.evaluate(async (aliceId) => {
      const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/features/voice/voice.ts")) ?? "/src/features/voice/voice.ts";
      const m = (await import(/* @vite-ignore */ url)) as { getRoom: () => import("livekit-client").Room | null };
      const p = m.getRoom()?.remoteParticipants.get(aliceId);
      const out: Record<string, { subscribed: boolean; volume: number | null }> = {};
      p?.trackPublications.forEach((pub) => {
        const key = pub.trackName === "soundboard" ? "soundboard" : pub.source;
        const track = pub.track as { getVolume?: () => number } | undefined;
        out[key] = { subscribed: pub.isSubscribed, volume: track?.getVolume?.() ?? null };
      });
      return out;
    }, alice.id);

  // A stream is offered, not downloaded.
  await a.page.getByRole("button", { name: "Показать экран" }).first().click();
  const stream = b.page.locator(`[data-user="${alice.id}"][data-source="screen"]`);
  await expect(stream.getByRole("button", { name: "Смотреть трансляцию" })).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await fromAlice()).screen_share?.subscribed).toBe(false);
  await stream.getByRole("button", { name: "Смотреть трансляцию" }).click();
  await expect(stream.locator("video")).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await fromAlice()).screen_share?.subscribed).toBe(true);

  // Its sound has its own switch, per person.
  await stream.hover();
  await stream.getByRole("button", { name: "Выключить звук трансляции" }).click();
  await expect(stream.getByRole("button", { name: "Включить звук трансляции" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await fromAlice()).screen_share_audio?.volume).toBe(0);
  await stream.getByRole("button", { name: "Включить звук трансляции" }).click();
  await expect.poll(async () => (await fromAlice()).screen_share_audio?.volume).toBe(1);

  // Stop watching: back to the offer.
  await stream.getByRole("button", { name: "Не смотреть" }).click();
  await expect(stream.getByRole("button", { name: "Смотреть трансляцию" })).toBeVisible();
  await expect.poll(async () => (await fromAlice()).screen_share?.subscribed).toBe(false);

  // Alice's soundboard sound arrives as a track of its own; Bob sets how loud it is for him.
  await a.page.getByRole("button", { name: "Саундпад" }).last().click();
  await a.page.locator('[data-clip="siren"]').click();
  await expect.poll(async () => (await fromAlice()).soundboard?.subscribed, { timeout: 15_000 }).toBe(true);
  await b.page.getByRole("button", { name: "Саундпад" }).last().click();
  const others = b.page.locator("[data-soundboard]").locator('input[type="range"]').nth(1);
  await others.fill("40");
  await expect.poll(async () => (await fromAlice()).soundboard?.volume).toBeCloseTo(0.4, 2);
  noErrors(a, b);
});
