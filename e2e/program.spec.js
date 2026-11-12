import { test, expect } from '@playwright/test';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';

async function recognitionWallet(context, identity, messages) {
  await context.exposeBinding('signRecognitionMessage', async (_, bytes) => {
    messages.push(new TextDecoder().decode(Uint8Array.from(bytes)));
    return Array.from(nacl.sign.detached(Uint8Array.from(bytes), identity.secretKey));
  });
  await context.addInitScript(({ address }) => {
    window.recognitionTransactions = 0;
    window.phantom = { solana: {
      isPhantom: true,
      connect: async () => ({ publicKey: { toString: () => address } }),
      signMessage: async message => ({ signature: Uint8Array.from(await window.signRecognitionMessage(Array.from(message))) }),
      signTransaction: async () => {
        window.recognitionTransactions++;
        throw new Error('Recognition must not request a token transaction.');
      },
    } };
  }, { address: identity.publicKey.toBase58() });
}

async function connect(page) {
  await page.locator('#connect-wallet').click();
  await page.getByRole('button', { name: /Phantom/ }).click();
  await expect(page.locator('#wallet-dialog')).not.toBeVisible();
}

test('Juicy Journey catalogs outcomes and keeps unearned recognition clear', async ({ page }) => {
  await page.goto('/#rewards');
  const catalog = page.locator('#program-missions');
  await expect(catalog.locator('.program-mission')).toHaveCount(6);
  await expect(catalog).not.toContainText(/\$|\bCAD\b|\bUSD\b/);
  await expect(page.locator('#program-wallet-state')).toContainText(/connect/i);
  await expect(page.locator('#program-submit')).toBeDisabled();
  await expect(page.locator('#program-stamp-count')).not.toContainText(/[1-9]/);
  await page.locator('[data-program-path="care"]').click();
  await expect(catalog.locator('.program-mission:visible')).toHaveCount(2);
  await page.locator('[data-program-path="all"]').click();
  await expect(catalog.locator('.program-mission:visible')).toHaveCount(6);
  await expect(page.locator('.legacy-drops')).not.toHaveAttribute('open', '');
});

test('a real signed contribution earns one reviewed stamp without a token mint or transaction', async ({ browser, baseURL }) => {
  test.skip(Boolean(process.env.BROWSER_BASE_URL), 'Recognition approval uses the temporary local reviewer identity.');
  const recipient = Keypair.generate();
  const reviewer = Keypair.fromSeed(new Uint8Array(32).fill(71));
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL })));
  const recipientMessages = [], reviewerMessages = [];
  await recognitionWallet(contexts[0], recipient, recipientMessages);
  await recognitionWallet(contexts[1], reviewer, reviewerMessages);
  try {
    const [member, host] = await Promise.all(contexts.map(context => context.newPage()));
    await member.goto('/#rewards');
    await connect(member);
    await member.locator('#program-mission').selectOption('welcome');
    const evidence = 'Helped a new member find the shared toolkit and complete their first useful step; they confirmed the result.';
    await member.locator('#program-evidence').fill(evidence);
    await member.locator('#program-submit').click();
    await expect(member.locator('#program-my-claims')).toContainText(evidence);
    await expect(member.locator('#program-my-claims')).toContainText('Awaiting review');
    await expect(member.locator('#program-stamp-count')).not.toContainText(/[1-9]/);

    await host.goto('/#rewards');
    await connect(host);
    await expect(host.locator('#program-review-panel')).toBeVisible();
    const review = host.locator('#program-review-list article').filter({ hasText: recipient.publicKey.toBase58() }).first();
    await expect(review).toContainText(evidence);
    await review.locator('textarea').fill('Confirmed the useful first step was completed and the newcomer received the help they needed.');
    await review.getByRole('button', { name: /Approve contribution/i }).click();
    await expect(review).toHaveCount(0);

    await member.locator('#program-refresh').click();
    await expect(member.locator('#program-title-state')).toHaveText('Spark');
    await expect(member.locator('#program-stamp-count')).toContainText('1');
    await expect(member.locator('#program-my-claims')).toContainText('Spark stamp earned');
    await expect(member.locator('#jcq-option')).toBeDisabled();
    expect(recipientMessages).toHaveLength(1);
    expect(reviewerMessages).toHaveLength(1);
    expect(await member.evaluate(() => window.recognitionTransactions)).toBe(0);
    expect(await host.evaluate(() => window.recognitionTransactions)).toBe(0);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
