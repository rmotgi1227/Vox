import { test, expect } from "@playwright/test";

test("specialist loads and switches image from chat", async ({ page }) => {
  await page.goto("/specialist");
  await expect(page.getByRole("heading", { name: "BMW M4" })).toBeVisible();
  await page.getByPlaceholder("Ask about this M4...").fill("Show me the interior");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".message.assistant")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".stage-topline span")).toContainText("interior front");
});

test("voice entry point is enabled", async ({ page }) => {
  await page.goto("/specialist");
  await expect(page.getByRole("button", { name: "Voice" })).toBeEnabled();
});

test("admin lists seeded images", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByText("Image ingestion")).toBeVisible();
  await expect(page.getByText(/exterior front|interior front|wheel/i).first()).toBeVisible();
});
