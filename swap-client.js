import { PublicKey, Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import bs58 from "bs58";

// A quote is read-only. Signing and submission require a second explicit action.
export function initSwaps({ getWallet, subscribe, withWalletLock, onConfirmed }) {
  const $ = (id) => document.getElementById(id);
  const els = {
    form: $("swap-form"), input: $("swap-input-mint"), output: $("swap-output-mint"),
    inputCustom: $("swap-input-custom"), outputCustom: $("swap-output-custom"),
    inputCustomField: $("swap-input-custom-field"), outputCustomField: $("swap-output-custom-field"),
    amount: $("swap-amount"), slippage: $("swap-slippage"), quote: $("swap-quote"),
    review: $("swap-review"), wallet: $("swap-wallet-address"), pay: $("swap-review-input"),
    receive: $("swap-review-output"), minimum: $("swap-review-minimum"),
    impact: $("swap-review-impact"),
    tolerance: $("swap-review-slippage"), expiry: $("swap-review-expiry"),
    confirm: $("swap-confirm"), status: $("swap-status"), receipt: $("swap-receipt"),
    receiptLink: $("swap-receipt-link"), checked: $("swap-checked"),
  };
  let settings = null;
  let reviewed = null;
  let busy = false;
  let uncertain = false;
  let revision = 0;
  let walletIdentity = "";
  let expiryAnnounced = false;

  function status(message, kind = "pending") {
    els.status.textContent = message;
    els.status.className = `status ${kind}`;
  }

  async function request(path, body) {
    const response = await fetch(path, {
      cache: "no-store",
      ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "The swap could not be completed. Please try again later.");
      error.signature = data.signature;
      throw error;
    }
    return data;
  }

  function mint(selection, custom) {
    return selection.value === "custom" ? custom?.value.trim() || "" : selection.value;
  }

  function selected() {
    return {
      inputMint: mint(els.input, els.inputCustom),
      outputMint: mint(els.output, els.outputCustom),
      amount: els.amount.value.trim(),
      slippageBps: Number(els.slippage.value),
    };
  }

  function validMint(value) {
    try { return new PublicKey(value).toBase58() === value; } catch { return false; }
  }

  function validInputs() {
    const input = selected();
    return validMint(input.inputMint) && validMint(input.outputMint) && input.inputMint !== input.outputMint &&
      /^(0|[1-9]\d*)(\.\d+)?$/.test(input.amount) && /[1-9]/.test(input.amount) && input.amount.length <= 80 &&
      [50, 100].includes(input.slippageBps);
  }

  function currentWalletMatches(wallet) {
    const current = getWallet();
    return current?.address === wallet.address && current?.cluster === "mainnet-beta";
  }

  function tokenDescription(amount, symbol, address) {
    return `${amount} ${symbol || "tokens"} · ${address}`;
  }

  function render() {
    const wallet = getWallet();
    const canSwap = settings?.ready && wallet?.cluster === "mainnet-beta";
    els.quote.disabled = busy || uncertain || !canSwap || !validInputs();
    for (const input of [els.input, els.output, els.inputCustom, els.outputCustom, els.amount, els.slippage]) {
      if (input) input.disabled = busy;
    }
    if (els.inputCustomField) els.inputCustomField.hidden = els.input.value !== "custom";
    if (els.outputCustomField) els.outputCustomField.hidden = els.output.value !== "custom";
    els.review.hidden = !reviewed;
    els.confirm.disabled = busy || uncertain || !canSwap || !reviewed || reviewed.expiresAt <= Date.now() || reviewed.wallet !== wallet?.address;
    els.checked.hidden = !uncertain;
    if (reviewed) {
      els.wallet.textContent = reviewed.wallet;
      els.pay.textContent = tokenDescription(reviewed.amount, reviewed.inputSymbol, reviewed.inputMint);
      els.receive.textContent = tokenDescription(reviewed.expectedOutput, reviewed.outputSymbol, reviewed.outputMint);
      els.minimum.textContent = tokenDescription(reviewed.minimumOutput, reviewed.outputSymbol, reviewed.outputMint);
      if (els.impact) els.impact.textContent = `${reviewed.priceImpactPct}%${Number(reviewed.priceImpactPct) >= 5 ? " · high price impact" : ""}`;
      els.tolerance.textContent = `${reviewed.slippageBps / 100}%`;
      const remaining = Math.max(0, Math.ceil((reviewed.expiresAt - Date.now()) / 1000));
      els.expiry.textContent = remaining ? `${remaining} seconds` : "Expired · get a new quote";
    }
  }

  function availabilityStatus() {
    const wallet = getWallet();
    if (!settings) return status("Loading swap availability…");
    if (!settings.ready) return status(settings.message || "Swaps need service setup by the app owner.");
    if (!wallet) return status("Connect a Solana wallet above to get a swap quote.");
    if (wallet.cluster !== "mainnet-beta") return status("Swaps are available on Solana mainnet only.");
    status("Choose your tokens and amount, then get a quote to review. Nothing is sent until you approve.");
  }

  function invalidateQuote() {
    revision++;
    reviewed = null;
    expiryAnnounced = false;
    if (!busy && !uncertain) availabilityStatus();
    render();
  }

  for (const input of [els.input, els.output, els.inputCustom, els.outputCustom, els.amount, els.slippage]) {
    input?.addEventListener("input", invalidateQuote);
    if (input?.tagName === "SELECT") input.addEventListener("change", invalidateQuote);
  }

  function exactUnits(amount, decimals) {
    if (typeof amount !== "string" || amount.length > 80 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(amount) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("The swap quote contained invalid token amounts.");
    const [whole, fraction = ""] = amount.split(".");
    if (fraction.length > decimals) throw new Error("The swap quote contained invalid token precision.");
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  }

  function validateQuote(quote, expected) {
    const impact = Number(quote.priceImpactPct);
    if (typeof quote.priceImpactPct !== "string" || !quote.priceImpactPct.trim() || !Number.isFinite(impact) || impact < 0 || impact > 20) {
      throw new Error("The swap quote did not provide a valid price impact estimate.");
    }
    if (typeof quote.quoteId !== "string" || !quote.quoteId || quote.wallet !== expected.wallet || quote.cluster !== "mainnet-beta" ||
      quote.inputMint !== expected.inputMint || quote.outputMint !== expected.outputMint || quote.slippageBps !== expected.slippageBps ||
      !Number.isFinite(quote.expiresAt) || quote.expiresAt <= Date.now() || quote.expiresAt > Date.now() + 120_000 ||
      exactUnits(quote.amount, quote.inputDecimals) !== exactUnits(expected.amount, quote.inputDecimals)) {
      throw new Error("The quote did not match your wallet, tokens, or amount. Get a new quote.");
    }
    const output = exactUnits(quote.expectedOutput, quote.outputDecimals);
    const minimum = exactUnits(quote.minimumOutput, quote.outputDecimals);
    if (minimum <= 0n || minimum > output) throw new Error("The quote did not provide a valid minimum receive amount.");
  }

  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (els.quote.disabled || busy) return;
    const wallet = getWallet();
    const expected = { ...selected(), wallet: wallet.address };
    const current = ++revision;
    reviewed = null;
    busy = true;
    status("Finding a supported swap route…");
    render();
    try {
      const quote = await request("/api/swaps/quote", expected);
      if (current !== revision || !currentWalletMatches(wallet)) throw new Error("Your wallet or swap details changed. Review them and get a new quote.");
      validateQuote(quote, expected);
      reviewed = quote;
      expiryAnnounced = false;
      status("Review the estimated and minimum receive amounts. Choose Approve swap in wallet only when you are ready.", "success");
    } catch (error) {
      status(error.message || "A swap quote is unavailable. Try another token pair.", "error");
    } finally {
      busy = false;
      render();
    }
  });

  function showReceipt(signature) {
    els.receipt.hidden = false;
    els.receiptLink.href = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`;
    els.receiptLink.textContent = signature;
  }

  els.confirm.addEventListener("click", async () => {
    if (els.confirm.disabled || busy || !reviewed) return;
    const quote = reviewed;
    const current = revision;
    busy = true;
    let submitted = false;
    let signature = null;
    els.receipt.hidden = true;
    status("Preparing the swap you reviewed…");
    render();
    try {
      await withWalletLock(async (wallet) => {
        const requireCurrent = () => {
          if (current !== revision || wallet.address !== quote.wallet || !currentWalletMatches(wallet)) throw new Error("Your wallet or swap details changed. The swap was not submitted.");
          if (quote.expiresAt <= Date.now()) throw new Error("This quote expired. Get a new quote before approving a swap.");
        };
        requireCurrent();
        const intent = await request("/api/swaps/prepare", { quoteId: quote.quoteId });
        requireCurrent();
        for (const field of ["wallet", "inputMint", "outputMint", "amount", "expectedOutput", "minimumOutput", "slippageBps", "cluster"]) {
          if (intent[field] !== quote[field]) throw new Error("The prepared swap changed. Get a fresh quote and review it again.");
        }
        if (typeof intent.intentId !== "string" || typeof intent.transaction !== "string" || intent.transaction.length > 1800) throw new Error("The swap transaction could not be verified.");
        const transaction = Transaction.from(Buffer.from(intent.transaction, "base64"));
        if (transaction.feePayer?.toBase58() !== quote.wallet || transaction.signatures.length !== 1 || transaction.signatures[0].publicKey.toBase58() !== quote.wallet || transaction.signatures.some((item) => item.signature)) {
          throw new Error("The prepared transaction does not belong to your wallet.");
        }
        const message = Buffer.from(transaction.serializeMessage());
        status("Approve the reviewed swap in your wallet. SOL network fees also apply.");
        const signed = await wallet.signTransaction(transaction);
        requireCurrent();
        if (!signed.signature || !Buffer.from(signed.serializeMessage()).equals(message) || !signed.verifySignatures()) throw new Error("The signed swap changed or was not signed by your wallet. Nothing was submitted.");
        signature = bs58.encode(signed.signature);
        const encoded = Buffer.from(signed.serialize()).toString("base64");
        showReceipt(signature);
        status("Swap submitted. Waiting for confirmation…");
        submitted = true;
        const result = await request("/api/swaps/submit", { intentId: intent.intentId, transaction: encoded });
        if (result.status !== "confirmed" || result.signature !== signature) throw new Error("Swap confirmation could not be verified.");
      });
      reviewed = null;
      els.amount.value = "";
      status("Your swap is confirmed. The received tokens are in your connected wallet.", "success");
      Promise.resolve().then(() => onConfirmed?.()).catch(() => {});
    } catch (error) {
      if (submitted && signature) {
        uncertain = true;
        showReceipt(signature);
        status(`${error.message || "Swap confirmation is unavailable."} Check the transaction and wallet history before trying again.`, "error");
      } else {
        reviewed = null;
        status(error.code === 4001 ? "Swap cancelled in your wallet. Nothing was submitted by this app." : error.message || "The swap was not submitted.", "error");
      }
    } finally {
      busy = false;
      render();
    }
  });

  els.checked.addEventListener("click", () => {
    uncertain = false;
    invalidateQuote();
    status("Check your wallet history and the transaction before starting another swap. Get a fresh quote for any new exchange.");
  });

  const unsubscribe = subscribe((wallet) => {
    const identity = wallet ? `${wallet.address}:${wallet.cluster}` : "";
    if (identity !== walletIdentity) { walletIdentity = identity; invalidateQuote(); }
  });

  async function loadSettings() {
    try {
      const config = await request("/api/swaps/config");
      if (!Array.isArray(config.tokens)) throw new Error();
      settings = config;
      invalidateQuote();
      for (const selection of [els.input, els.output]) {
        selection.replaceChildren();
        const seen = new Set();
        for (const token of config.tokens) {
          if (!validMint(token.mint) || seen.has(token.mint)) continue;
          seen.add(token.mint);
          const option = document.createElement("option");
          option.value = token.mint;
          option.textContent = token.symbol || `${token.mint.slice(0, 6)}…${token.mint.slice(-4)}`;
          selection.append(option);
        }
        const custom = selection === els.input ? els.inputCustom : els.outputCustom;
        if (custom) {
          const option = document.createElement("option");
          option.value = "custom";
          option.textContent = "Other SPL token…";
          selection.append(option);
        }
      }
      if (els.output.options.length > 1) els.output.selectedIndex = 1;
      availabilityStatus();
    } catch {
      settings = { ready: false };
      status("Swap settings are unavailable. Reload the page to try again.", "error");
    }
    render();
  }

  const timer = setInterval(() => {
    if (reviewed && !busy && !uncertain && reviewed.expiresAt <= Date.now() && !expiryAnnounced) {
      expiryAnnounced = true;
      status("This quote expired. Get a fresh quote and review the amounts again.");
    }
    render();
  }, 1000);
  render();
  void loadSettings();
  return { refresh: loadSettings, destroy() { clearInterval(timer); unsubscribe?.(); } };
}
