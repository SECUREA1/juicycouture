import { test, expect } from "@playwright/test";
import nacl from "tweetnacl";
import sharp from "sharp";
import { Keypair, Transaction, SystemInstruction } from "@solana/web3.js";

// Payment browser tests use the local fixture and never target a hosted chain.
test.skip(Boolean(process.env.BROWSER_BASE_URL), "Wallet tests require the local simulated Solana RPC server.");

async function mockWallet(context, name, payer, signed) {
  await context.exposeBinding("signTestTransaction", async (_, bytes) => {
    const tx = Transaction.from(Uint8Array.from(bytes));
    signed.push(SystemInstruction.decodeTransfer(tx.instructions[0]));
    tx.sign(payer);
    return Array.from(tx.serialize());
  });
  await context.exposeBinding("signTestMessage", async (_, bytes) => Array.from(nacl.sign.detached(Uint8Array.from(bytes), payer.secretKey)));
  await context.addInitScript(({ name, address, key }) => {
    if (name === "Phantom") {
      window.phantom = { solana: {
        isPhantom: true,
        signMessage: async (message) => ({ signature: Uint8Array.from(await window.signTestMessage(Array.from(message))) }),
        connect: async () => ({ publicKey: { toString: () => address } }),
        signTransaction: async (tx) => tx.constructor.from(Uint8Array.from(await window.signTestTransaction(Array.from(tx.serialize({ requireAllSignatures: false }))))),
      } };
    } else {
      const account = { address, publicKey: Uint8Array.from(key), chains: ["solana:devnet"], features: ["solana:signTransaction", "solana:signMessage"] };
      const wallet = { version: "1.0.0", name: "MetaMask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", chains: ["solana:devnet"], accounts: [], features: {
        "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
        "solana:signMessage": { version: "1.0.0", signMessage: async ({ message }) => [{ signedMessage: message, signature: Uint8Array.from(await window.signTestMessage(Array.from(message))) }] },
        "standard:events": { version: "1.0.0", on: () => () => {} },
        "solana:signTransaction": { version: "1.0.0", signTransaction: async ({ transaction }) => [{ signedTransaction: Uint8Array.from(await window.signTestTransaction(Array.from(transaction))) }] },
      } };
      const register = (api) => api.register(wallet);
      window.addEventListener("wallet-standard:app-ready", (event) => register(event.detail));
      window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
    }
  }, { name, address: payer.publicKey.toBase58(), key: Array.from(payer.publicKey.toBytes()) });
}

for (const name of ["Phantom", "MetaMask"]) test(`${name} approves an exact host tip and both users receive a verified receipt`, async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext({ baseURL, permissions: ["camera", "microphone"] });
  const guestContext = await browser.newContext({ baseURL, permissions: ["camera", "microphone"] });
  const payer = Keypair.generate(); const receiver = Keypair.generate().publicKey.toBase58();
  const signed = [];
  await mockWallet(guestContext, name, payer, signed);
  try {
    const host = await hostContext.newPage(), guest = await guestContext.newPage();
    const room = `tips-${name.toLowerCase()}-${Date.now()}`;
    for (const [page, display, selector] of [[host, "Lovely Host", "#host-room"], [guest, "Lovely Viewer", "#join-room"]]) {
      await page.goto("/");
      await expect(page.locator(selector)).toBeEnabled();
      await page.locator("#display-name").fill(display);
      await page.locator("#room-code").fill(room);
      await page.locator(selector).click();
      await expect(page.locator("#live-room")).toHaveClass(/connected/);
    }
    await expect(host.locator("#host-settings")).toBeVisible();
    await host.locator("#host-settings summary").click();
    await host.locator("#host-wallet").fill(receiver);
    await host.locator("#save-host-wallet").click();
    await expect(guest.locator("#payout-address")).toHaveText(receiver);
    await expect(guest.locator("#host-settings")).toBeHidden();
    await guest.locator("#connect-wallet").click();
    await guest.getByRole("button", { name: new RegExp(name) }).click();
    await expect(guest.locator("#wallet-label")).toContainText(payer.publicKey.toBase58().slice(0, 5));
    expect(signed).toHaveLength(0);
    await expect(guest.locator("#jcq-option")).toBeDisabled();
    await guest.locator("#review-tip").click();
    await expect(guest.locator("#tip-review")).toContainText(receiver);
    await expect(guest.locator("#tip-review")).toContainText("devnet");
    expect(signed).toHaveLength(0);
    await guest.locator("#approve-tip").click();
    await expect(guest.locator("#tip-events")).toContainText("sent 0.01 SOL");
    await expect(host.locator("#tip-events")).toContainText("sent 0.01 SOL");
    expect(signed).toHaveLength(1);
    expect(signed[0].toPubkey.toBase58()).toBe(receiver);
    expect(signed[0].lamports).toBe(10_000_000n);
    await expect(guest.locator("#tip-receipt")).toHaveAttribute("href", /explorer\.solana\.com\/tx\/.*cluster=devnet/);

    // A recipient change invalidates an already-open review before signing.
    await guest.locator("#review-tip").click();
    const different = Keypair.generate().publicKey.toBase58();
    await host.locator("#host-wallet").fill(different);
    await host.locator("#save-host-wallet").click();
    await expect(guest.locator("#payout-address")).toHaveText(different);
    await guest.locator("#approve-tip").click();
    await expect(guest.locator("#approval-status")).toContainText("changed");
    expect(signed).toHaveLength(1);
  } finally { await hostContext.close(); await guestContext.close(); }
});

test("an Ethereum-only MetaMask connection is not used for Solana payments", async ({ page }) => {
  await page.addInitScript(() => {
    window.ethereumCalls = 0;
    window.ethereum = { isMetaMask: true, request: () => { window.ethereumCalls++; } };
  });
  await page.goto("/");
  await page.locator("#connect-wallet").click();
  await page.getByRole("button", { name: /MetaMask/ }).click();
  await expect(page.locator("#wallet-status")).toContainText("Solana support was not detected");
  expect(await page.evaluate(() => window.ethereumCalls)).toBe(0);
  await expect(page.locator("#wallet-label")).toHaveText("Connect wallet");
});


test("the shared connected wallet can sign in, post and delete a community photo without a payment", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const signed = [];
  await mockWallet(context, "Phantom", Keypair.generate(), signed);
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("#join-room")).toBeEnabled();
    await page.locator("#connect-wallet").click();
    await page.getByRole("button", { name: /Phantom/ }).click();
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#eab1ca" } }).png().toBuffer();
    await page.locator("#feed-image").setInputFiles({ name: "community.png", mimeType: "image/png", buffer: image });
    await page.locator("#feed-caption").fill("A lovely shared moment");
    await page.locator("#feed-submit").click();
    await expect(page.locator("#feed-posts")).toContainText("A lovely shared moment");
    expect(signed).toHaveLength(0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator(".feed-delete").first().click();
    await expect(page.locator("#feed-posts")).not.toContainText("A lovely shared moment");
  } finally { await context.close(); }
});
