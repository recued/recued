import { expect, type Page } from '@playwright/test';
export const jobCards = (page: Page) => page.locator('[data-job-list]:visible>article');
export const openJob = async (page: Page, tab = 'overview', index = 0) => {
    if (!await page.getByRole('navigation', { name: 'Job sections', exact: true }).count())
        await jobCards(page).nth(index).getByRole('link', { name: 'Open job', exact: true }).click();
    await expect(page.locator('[data-customer-job-header] h2')).not.toHaveText('Customer job');
    await page.getByRole('navigation', { name: 'Job sections', exact: true }).getByRole('link', { name: { overview: 'Overview', activity: 'Activity', billing: 'Billing', followups: 'Follow-ups', closeout: 'Closeout' }[tab], exact: true }).click();
    await expect(page.getByRole('navigation',{name:'Job sections',exact:true}).getByRole('link',{name:{overview:'Overview',activity:'Activity',billing:'Billing',followups:'Follow-ups',closeout:'Closeout'}[tab],exact:true})).toHaveAttribute('aria-current','page');
    await expect(page.locator('[data-customer-job-header] h2')).not.toHaveText('Customer job');
};
export const boardFilters = async (page: Page) => { const details = page.locator('[data-job-more-filters]:visible'); if (!await details.getAttribute('open')) {
    if (!await details.evaluate(n => (n as HTMLDetailsElement).open))
        await details.locator('summary').click();
} };
export const openAccountActions = async (page: Page) => { for (const node of await page.locator('[data-customer-account-list] details').all())
    if (!await node.evaluate(n => (n as HTMLDetailsElement).open))
        await node.locator('summary').click(); };
export const invoiceSection = async (page: Page, name: 'Credits' | 'Refunds' | 'Documents' | 'Payments') => { await page.getByRole('navigation', { name: 'Invoice billing sections' }).getByRole('button', { name, exact: true }).click(); };
