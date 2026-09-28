// Visual tour: screenshots of every major screen at common sizes, for review.
// Not part of the normal run:  SCREENS=1 npm run e2e -- screens   (→ .e2e-screens/)
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { api, grantAdmin, guildWith, openAs, register } from "./helpers";

test.skip(!process.env.SCREENS, "visual tour runs only with SCREENS=1");
test.setTimeout(10 * 60_000);

const SIZES = [
  { name: "1920", width: 1920, height: 1080 },
  { name: "1366", width: 1366, height: 768 },
  { name: "phone", width: 390, height: 844 },
];

test("visual tour", async ({ browser, request }) => {
  const alice = await register(request, "Алиса Звёздная");
  const bob = await register(request, "Борис");
  const { guild, text, voice } = await guildWith(request, alice, [bob], "gaming");
  const admin = !process.env.E2E_URL;
  if (admin) grantAdmin(alice);
  await api(request, alice, "PATCH", "/api/users/@me", { bio: "Люблю **Markdown** и звонки по вечерам.", pronouns: "она" });
  for (const m of [
    "Всем привет! Это **Concord Nova** — проверяем, как выглядит длинное сообщение, которое переносится на несколько строк и не ломает вёрстку.",
    "```ts\nconst hello = (name: string) => `Привет, ${name}!`;\n```",
    "> цитата\nи ответ под ней 🚀",
    "Ссылка: https://example.com",
  ])
    await api(request, alice, "POST", `/api/channels/${text.id}/messages`, { content: m });
  await api(request, bob, "POST", `/api/channels/${text.id}/messages`, { content: "Отвечаю: всё отлично выглядит 👍" });

  for (const size of SIZES) {
    const phone = size.name === "phone";
    const s = await openAs(browser, alice, `/#/channels/${guild.id}/${text.id}`, { viewport: size });
    const p = s.page;
    // Outside .e2e-results, which Playwright empties at the start of every run.
    const dir = fileURLToPath(new URL(`../.e2e-screens/${size.name}/`, import.meta.url));
    const shot = async (name: string) => {
      await p.waitForTimeout(450);
      await p.screenshot({ path: `${dir}/${name}.png` });
    };
    const openSettings = async () => {
      if (phone) {
        const back = p.getByRole("button", { name: "Назад" }).first();
        if (await back.isVisible().catch(() => false)) await back.click();
      }
      await p.getByRole("button", { name: "Настройки" }).last().click();
    };

    await shot("01-channel");
    if (!phone) {
      await p.getByRole("button", { name: "Эмодзи" }).last().click();
      await shot("02-emoji");
      await p.keyboard.press("Escape");
      await p.locator("[data-mid]").first().click({ button: "right" });
      await shot("03-message-menu");
      await p.keyboard.press("Escape");
      await p.keyboard.press("Control+k");
      await shot("04-quick-switcher");
      await p.keyboard.press("Escape");
      await p.getByRole("button", { name: "Закреплённые сообщения" }).click();
      await shot("05-pins");
      await p.getByRole("button", { name: "Поиск" }).first().click();
      await shot("06-search");
    }

    // User settings, every section.
    await openSettings();
    const sections = ["Аккаунт", "Профиль", "Устройства", "Внешний вид", "Голос и видео", "Уведомления", "Горячие клавиши", "Язык", "Расширенные", "О программе"];
    if (admin) sections.push("Обзор", "Пользователи", "Серверы");
    for (const [i, name] of sections.entries()) {
      await p.locator("[data-settings] nav").getByRole("button", { name, exact: true }).click();
      await shot(`10-settings-${String(i).padStart(2, "0")}-${name}`);
      if (phone) await p.getByRole("button", { name: "Назад" }).first().click();
    }
    await p.keyboard.press("Escape");
    if (phone) {
      const close = p.getByRole("button", { name: "Закрыть" }).first();
      if (await close.isVisible().catch(() => false)) await close.click();
    }

    // Server settings, every section.
    if (phone) {
      const back = p.getByRole("button", { name: "Назад" }).first();
      if (await back.isVisible().catch(() => false)) await back.click();
    }
    await p.getByText(guild.name).first().click();
    await p.getByRole("menuitem", { name: "Настройки сервера" }).click();
    await expect(p.locator("[data-settings] nav")).toBeVisible(); // lazy-loaded
    const gsections = ["Обзор", "Роли", "Эмодзи", "Участники", "Приглашения", "Баны", "Журнал аудита"];
    for (const [i, name] of gsections.entries()) {
      const item = p.locator("[data-settings] nav").getByRole("button", { name, exact: true });
      if (!(await item.isVisible().catch(() => false))) continue;
      await item.click();
      await shot(`20-server-${String(i).padStart(2, "0")}-${name}`);
      if (phone) await p.getByRole("button", { name: "Назад" }).first().click();
    }
    await p.keyboard.press("Escape");
    if (phone) {
      const close = p.getByRole("button", { name: "Закрыть" }).first();
      if (await close.isVisible().catch(() => false)) await close.click();
    }

    // Dialogs.
    await p.getByRole("button", { name: "Добавить сервер" }).click();
    await shot("30-create-server");
    await p.keyboard.press("Escape");
    await p.getByText(guild.name).first().click();
    await p.getByRole("menuitem", { name: /Пригласить/ }).click();
    await shot("31-invite");
    await p.keyboard.press("Escape");

    // Voice with two people.
    const b = await openAs(browser, bob, `/#/channels/${guild.id}/${voice.id}`, { viewport: { width: 1280, height: 720 } });
    await b.page.getByRole("button", { name: "Зайти в канал" }).click();
    await p.goto(`/#/channels/${guild.id}/${voice.id}`);
    await p.getByRole("button", { name: "Зайти в канал" }).click();
    await expect(p.locator(`[data-user="${bob.id}"]`).first()).toBeVisible();
    await shot("40-voice");
    await p.getByRole("button", { name: "Отключиться" }).first().click();
    await b.context.close();

    // Friends / home.
    await p.goto("/#/channels/@me");
    await shot("50-home");
    await s.context.close();
  }
});
