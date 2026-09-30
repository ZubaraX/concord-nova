import { expect, test } from "@playwright/test";
import { api, guildWith, handle, messageRow, noErrors, openAs, register } from "./helpers";

test("names: the username dialog says what is wrong, a server nickname shows for everyone", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, text } = await guildWith(request, alice, [bob]);
  await api(request, alice, "POST", `/api/channels/${text.id}/messages`, { content: "кто я?" });
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${text.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${text.id}`);
  const p = a.page;

  // Username: a dialog (it used to be a form hidden at the bottom of the page).
  await p.getByRole("button", { name: "Настройки" }).last().click();
  await p.locator("[data-settings]").getByRole("button", { name: "Изменить" }).first().click();
  const dlg = p.getByRole("dialog").last();
  await dlg.locator("input").first().fill("Плохое Имя");
  await dlg.locator('input[type="password"]').fill(alice.password);
  await dlg.getByRole("button", { name: "Сохранить" }).click();
  // The rule is shown as a hint in the dialog and again as the error.
  await expect(p.getByText(/Только латиница в нижнем регистре/)).toHaveCount(2);
  a.errors.length = 0; // the refused request (400) is the point of this step
  const next = handle("n");
  await dlg.locator("input").first().fill(next);
  await dlg.getByRole("button", { name: "Сохранить" }).click();
  await expect(p.locator("[data-settings]").getByText(`@${next}`).first()).toBeVisible();
  await expect(p.getByRole("dialog")).toHaveCount(0);
  await p.keyboard.press("Escape");
  await expect(p.locator("[data-settings]")).toHaveCount(0);

  // Nickname on this server, from the member's menu (the member list).
  await p.getByText("Алиса", { exact: true }).last().click({ button: "right" });
  await p.getByRole("menuitem", { name: "Сменить ник на сервере" }).click();
  await p.getByRole("dialog").locator("input").fill("Капитан");
  await p.getByRole("dialog").getByRole("button", { name: "Сохранить" }).click();
  await expect(messageRow(b.page, "кто я?")).toContainText("Капитан");
  noErrors(a, b);
});

test("profile style: decoration, effect and gradient are seen by others", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, text } = await guildWith(request, alice, [bob]);
  await api(request, alice, "POST", `/api/channels/${text.id}/messages`, { content: "смотрите, корона" });
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${text.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${text.id}`);
  const p = a.page;

  await p.getByRole("button", { name: "Настройки" }).last().click();
  await p.locator("[data-settings] nav").getByRole("button", { name: "Профиль", exact: true }).click();
  await p.getByRole("button", { name: "Корона", exact: true }).click();
  await p.locator("[data-profile-effects]").getByRole("button", { name: "Волны" }).click();
  // Two colours from the palette: a gradient.
  for (const [label, hex] of [
    ["Цвет профиля", "#7a3cff"],
    ["Второй цвет", "#ff5c9a"],
  ]) {
    await p.getByRole("button", { name: label, exact: true }).click();
    await p.locator("[data-color-picker]").getByLabel("HEX").fill(hex);
    await p.keyboard.press("Escape");
  }
  // The preview shows all of it before saving.
  const preview = p.locator("[data-profile-preview]");
  await expect(preview.locator("svg.decor")).toBeVisible();
  await expect(preview.locator('[data-backdrop="waves"]')).toBeVisible();
  await p.getByRole("button", { name: "Сохранить" }).click();
  await expect(p.getByText("Сохранено")).toBeVisible();

  // Bob: the crown on her avatar in the chat, the effect and gradient in her profile.
  const row = messageRow(b.page, "смотрите, корона");
  await expect(row.locator("svg.decor")).toBeVisible();
  await row.getByText("Алиса").first().click();
  const card = b.page.getByRole("dialog");
  await expect(card.locator('[data-backdrop="waves"]')).toBeVisible();
  await expect(card.locator("svg.decor")).toBeVisible();
  const me = await api<{ accentColor: number; accentColor2: number; decoration: string; profileEffect: string }>(request, alice, "GET", "/api/users/@me");
  expect(me).toMatchObject({ accentColor: 0x7a3cff, accentColor2: 0xff5c9a, decoration: "crown", profileEffect: "waves" });
  noErrors(a, b);
});

test("appearance: a theme from any colour, an animated chat wallpaper", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const { guild, text } = await guildWith(request, alice, []);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${text.id}`);
  const p = a.page;
  const scheme = () => p.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  const canvas = () => p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim());

  await p.getByRole("button", { name: "Настройки" }).last().click();
  await p.locator("[data-settings] nav").getByRole("button", { name: "Внешний вид", exact: true }).click();
  const nova = await canvas();
  await p.locator("[data-settings]").getByRole("button", { name: /Своя/ }).click();
  await expect(p.locator("html")).toHaveAttribute("data-theme", "custom");
  // A dark green pick: a dark theme in that hue.
  await p.getByRole("button", { name: "Цвет темы" }).click();
  await p.locator("[data-color-picker]").getByLabel("HEX").fill("#123c3a");
  await expect.poll(canvas).not.toBe(nova);
  expect(await scheme()).toBe("dark");
  const [r, g, bl] = (await canvas()).split(" ").map(Number);
  expect(g, "greenish surfaces").toBeGreaterThan(r);
  expect(Math.max(r, g, bl), "still dark").toBeLessThan(60);
  // A pale pick turns the whole theme light.
  await p.locator("[data-color-picker]").getByLabel("HEX").fill("#e8f0ff");
  await expect.poll(scheme).toBe("light");
  await p.keyboard.press("Escape");

  // Wallpaper: behind the messages, and still there after a reload (it is a synced setting).
  await p.locator("[data-wallpapers]").getByRole("button", { name: "Звёзды" }).click();
  await p.keyboard.press("Escape");
  await expect(p.locator('[data-wallpaper="stars"]')).toBeAttached();
  await p.waitForTimeout(1200); // the debounced sync
  await p.reload();
  await expect(p.locator('[data-wallpaper="stars"]')).toBeAttached({ timeout: 20_000 });
  await expect(p.locator("html")).toHaveAttribute("data-theme", "custom");
  noErrors(a);
});

/** Half a second of a 440 Hz tone as a WAV file. */
function wav(): Buffer {
  const sr = 8000;
  const n = sr / 2;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000), 44 + i * 2);
  return b;
}

test("ringtone: pick a melody, preview it, upload your own", async ({ browser, request }) => {
  const a = await openAs(browser, await register(request, "Алиса"));
  const p = a.page;
  await p.getByRole("button", { name: "Настройки" }).last().click();
  await p.locator("[data-settings] nav").getByRole("button", { name: "Уведомления", exact: true }).click();
  const list = p.locator("[data-ringtones]");
  await list.getByRole("button", { name: "Пульс" }).click();
  await expect(list.getByRole("button", { name: "Пульс" })).toHaveAttribute("aria-pressed", "true");
  await list.getByRole("button", { name: "Воспроизвести" }).nth(2).click();

  const chooser = p.waitForEvent("filechooser");
  await p.getByRole("button", { name: "Загрузить свою" }).click();
  await (await chooser).setFiles({ name: "my-ring.wav", mimeType: "audio/wav", buffer: wav() });
  await expect(list.getByRole("button", { name: "my-ring.wav" })).toHaveAttribute("aria-pressed", "true");
  // Not audio: refused with a reason, the choice stays.
  const chooser2 = p.waitForEvent("filechooser");
  await p.getByRole("button", { name: "Загрузить свою" }).click();
  await (await chooser2).setFiles({ name: "notes.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("this is not audio") });
  await expect(p.getByText("Не получилось прочитать этот аудиофайл.")).toBeVisible();
  await expect(list.getByRole("button", { name: "my-ring.wav" })).toBeVisible();
  // It survives a reload (kept on the device).
  await p.reload();
  await p.getByRole("button", { name: "Настройки" }).last().click();
  await p.locator("[data-settings] nav").getByRole("button", { name: "Уведомления", exact: true }).click();
  await expect(p.locator("[data-ringtones]").getByRole("button", { name: "my-ring.wav" })).toHaveAttribute("aria-pressed", "true");
  noErrors(a);
});
