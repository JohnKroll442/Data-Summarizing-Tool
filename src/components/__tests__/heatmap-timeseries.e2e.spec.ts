import { test, expect } from '@playwright/test';

test.describe('Time-Series Heatmap static thresholds', () => {
  test('fails RED until thresholds implemented: green=0, yellow=1, red>=2', async ({ page }) => {
    await page.goto('/components/heatmap-timeseries-story');

    // Minimal dataset on the tour page
    const firstGreen = page.getByTestId('cell-green');
    const firstYellow = page.getByTestId('cell-yellow');
    const firstRed   = page.getByTestId('cell-red');

    // Expect at least one of each color based on mocked thresholds
    await expect(firstYellow).toBeVisible();
    await expect(firstRed).toBeVisible();
    await expect(firstGreen).toBeVisible();
  });
});
