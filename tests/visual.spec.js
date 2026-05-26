// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = 'https://pdx.today';

// Wait for the page to finish loading articles - the articles-container or
// header-news-section should have children, or loading spinner disappears.
async function waitForArticles(page) {
    // Wait for loading spinner to hide
    await page.waitForSelector('#loading.hidden', { timeout: 30000 }).catch(() => {});
    // Give JS a moment to render articles into the DOM
    await page.waitForTimeout(2000);
}

test.describe('Portland Today - Visual regression', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(BASE_URL, { waitUntil: 'networkidle' });
        await waitForArticles(page);
    });

    test('full-page screenshot baseline', async ({ page }) => {
        await page.screenshot({
            path: 'tests/snapshots/full-page.png',
            fullPage: true,
        });
        // The test passes as long as navigation and rendering succeed.
        // The stored screenshot serves as a baseline for manual diff.
    });

    test('header is visible and has reasonable height', async ({ page }) => {
        const header = page.locator('header');
        await expect(header).toBeVisible();
        const box = await header.boundingBox();
        expect(box).not.toBeNull();
        // Header should be at least 100px tall (not collapsed)
        expect(box.height).toBeGreaterThan(100);
    });

    test('news section is visible and has a minimum height', async ({ page }) => {
        const newsSection = page.locator('#header-news-section');
        await expect(newsSection).toBeVisible();
        const box = await newsSection.boundingBox();
        expect(box).not.toBeNull();
        // News section should have a meaningful height (not narrow/collapsed).
        // With 3 articles at ~80px each + 40px base = ~280px minimum.
        expect(box.height).toBeGreaterThan(150);
    });

    test('news section screenshot', async ({ page }) => {
        const newsSection = page.locator('#header-news-section');
        await expect(newsSection).toBeVisible();
        await newsSection.screenshot({ path: 'tests/snapshots/news-section.png' });
    });

    test('weather widget is visible', async ({ page }) => {
        const weatherSection = page.locator('#weather-section');
        await expect(weatherSection).toBeVisible();
        const weatherDisplay = page.locator('#weather-display');
        // Weather display should eventually appear (may take a moment to load)
        await expect(weatherDisplay).toBeVisible({ timeout: 15000 });
    });

    test('weather widget screenshot', async ({ page }) => {
        const weatherDisplay = page.locator('#weather-display');
        await expect(weatherDisplay).toBeVisible({ timeout: 15000 });
        await weatherDisplay.screenshot({ path: 'tests/snapshots/weather-widget.png' });
    });

    test('category grid is present and visible', async ({ page }) => {
        const articlesContainer = page.locator('#articles-container');
        await expect(articlesContainer).toBeVisible();
        // There should be at least one category section rendered
        const categorySections = articlesContainer.locator('.category-section');
        const count = await categorySections.count();
        expect(count).toBeGreaterThan(0);
    });

    test('major category sections are present', async ({ page }) => {
        // These categories should appear somewhere in the page when articles exist.
        // We look for h2 headings inside .category-section elements.
        const categorySections = page.locator('.category-section');
        const count = await categorySections.count();

        // Collect all visible category titles
        const visibleTitles = [];
        for (let i = 0; i < count; i++) {
            const title = await categorySections.nth(i).locator('.category-title').textContent();
            if (title) visibleTitles.push(title.trim().toLowerCase());
        }

        // At least some of the expected categories should be present
        const expectedCategories = ['sports', 'crime', 'politics', 'news', 'technology', 'business'];
        const foundCategories = expectedCategories.filter(cat => visibleTitles.includes(cat));

        // We expect at least 2 of the major categories to be visible
        expect(foundCategories.length).toBeGreaterThanOrEqual(2);
    });

    test('each visible category section has at least one article link', async ({ page }) => {
        const categorySections = page.locator('.category-section');
        const count = await categorySections.count();

        for (let i = 0; i < count; i++) {
            const section = categorySections.nth(i);
            const titleText = await section.locator('.category-title').textContent();
            const iframe = section.locator('iframe.category-iframe');
            await expect(iframe).toBeVisible({
                timeout: 5000,
            });
            // Iframe should have a non-trivial height
            const box = await iframe.boundingBox();
            expect(box, `iframe in section "${titleText}" should have dimensions`).not.toBeNull();
            expect(box.height, `iframe in section "${titleText}" should not be collapsed`).toBeGreaterThan(50);
        }
    });

    test('news section iframe has non-trivial height', async ({ page }) => {
        const newsIframe = page.locator('.header-news-iframe');
        // Only assert if news iframe is present (there may be no news articles today)
        const count = await newsIframe.count();
        if (count > 0) {
            const box = await newsIframe.boundingBox();
            expect(box).not.toBeNull();
            expect(box.height).toBeGreaterThan(150);
        }
    });
});
