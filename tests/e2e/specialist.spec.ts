import { test, expect } from "@playwright/test";

test("specialist loads and switches image from chat", async ({ page }) => {
  await page.goto("/specialist");
  await expect(page.getByRole("heading", { name: /2026 BMW M4/ })).toBeVisible();
  await page.locator("#composer-input").fill("Show me the interior");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".message.assistant")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".canvas-caption")).toContainText("interior front", { timeout: 15_000 });
});

test("voice entry point is enabled", async ({ page }) => {
  await page.goto("/specialist");
  await expect(page.locator(".voice-cta")).toBeEnabled();
});

test("admin lists seeded images", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByText("Image ingestion")).toBeVisible();
  await expect(page.getByText(/exterior front|interior front|wheel/i).first()).toBeVisible();
});
