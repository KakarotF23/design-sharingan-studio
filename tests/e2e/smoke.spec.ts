import { test, expect } from "@playwright/test";

test("Studio landing page exposes both project entry paths", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Design Sharingan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Local Project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import GitHub Repo" })).toBeVisible();
});
