import { expect, test } from "@playwright/test";
import { guildWith, messageRow, noErrors, openAs, register, send } from "./helpers";

test("voice message: record from the (fake) mic, the other side gets a player", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, text } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${text.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${text.id}`);
  await a.page.getByRole("button", { name: "Файлы и другое" }).click();
  await a.page.getByRole("menuitem", { name: "Голосовое сообщение" }).click();
  await a.page.waitForTimeout(1500);
  await a.page.getByRole("button", { name: "Отправить" }).last().click();
  await expect(b.page.getByRole("button", { name: "Воспроизвести" }).last()).toBeVisible({ timeout: 20_000 });
  noErrors(a, b);
});

test("phone layout: navigate, emoji picker, settings, back", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const { guild, text } = await guildWith(request, alice, []);
  const s = await openAs(browser, alice, `/#/channels/${guild.id}/${text.id}`, { viewport: { width: 390, height: 844 } });
  const p = s.page;
  await send(p, "С телефона");
  await expect(messageRow(p, "С телефона")).toBeVisible();
  await p.getByRole("button", { name: "Эмодзи" }).click();
  await expect(p.getByPlaceholder("Найти эмодзи")).toBeVisible();
  await p.getByPlaceholder("Найти эмодзи").fill("огонь");
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: "Назад" }).first().click();
  await p.getByRole("button", { name: "Настройки" }).last().click();
  await p.getByRole("button", { name: "Голос и видео", exact: true }).click();
  await expect(p.getByText("Шумоподавление")).toBeVisible();
  // Nothing sticks out sideways on a phone.
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await p.getByRole("button", { name: "Назад" }).first().click();
  await p.getByRole("button", { name: "Закрыть" }).first().click();
  await p.getByText(text.name).first().click();
  await expect(messageRow(p, "С телефона")).toBeVisible();
  noErrors(s);
});

test("desktop app chrome: the title bar stays reachable over settings and dialogs", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const s = await openAs(browser, alice, "/#/channels/@me", { desktop: true });
  const p = s.page;
  const bar = p.locator(".drag-region");
  await expect(bar).toBeVisible();
  await p.getByRole("button", { name: "Настройки" }).last().click();
  await expect(p.getByRole("button", { name: "Свернуть" })).toBeVisible();
  // (after the open animation settles) the layer starts below the 32px title bar
  await expect.poll(() => p.locator("[data-settings]").evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBe(32);
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: "Добавить сервер" }).click();
  await expect(p.getByRole("button", { name: "Закрыть" }).last()).toBeVisible();
  await expect(p.getByRole("button", { name: "Свернуть" })).toBeVisible();
  noErrors(s);
});
