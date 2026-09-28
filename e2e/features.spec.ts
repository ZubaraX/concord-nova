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
  await expect(b.page.locator(`[data-user="${alice.id}"][data-source="screen"]`)).toBeVisible({ timeout: 20_000 });
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
