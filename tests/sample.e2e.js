import { test, expect } from '@playwright/test';

test.describe('SillyAgent startup smoke test', () => {
    test('serves the UI and exposes the native agent tool registry', async ({ page, request }) => {
        await page.goto('/');
        await page.waitForFunction(
            () => document.getElementById('preloader') === null,
            null,
            { timeout: 30000 },
        );
        await expect(page).toHaveTitle('SillyTavern');

        const response = await request.get('/api/agent/tools/');
        expect(response.ok()).toBe(true);

        const payload = await response.json();
        const toolNames = payload.tools.map(tool => tool?.function?.name).filter(Boolean);
        expect(toolNames).toContain('memory_search');
        expect(toolNames).toContain('roleplay_roll_dice');
    });
});
