import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, decodeTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Buffer } from "buffer";
import bs58 from "bs58";

// Signing happens only in the user's wallet after an explicit form submission.
export function initTips({ getRoom }) {
  const $ = (id) => document.getElementById(id);
  const els = {
    form: $("tip-form"), wallet: $("tip-wallet"), connect: $("tip-connect"), disconnect: $("tip-disconnect"),
    account: $("tip-account"), state: $("tip-stream-state"), recipient: $("tip-recipient"), mint: $("tip-mint"),
    cluster: $("tip-cluster"), amount: $("tip-amount"), review: $("tip-review-amount"), send: $("tip-send"),
    status: $("tip-status"), receipt: $("tip-receipt"), receiptLink: $("tip-receipt-link"), checked: $("tip-checked"),
  };
  let stream = null;
  let provider = null;
  let address = null;
  let busy = false;
  let uncertain = false;
  let revision = 0;

  function status(message, kind = "pending") {
    els.status.textContent = message;
    els.status.className = `status ${kind}`;
  }

  function render() {
    const joined = Boolean(getRoom());
    els.account.textContent = address || "No wallet connected";
    els.recipient.textContent = stream?.recipient || "Not configured";
    els.mint.textContent = stream?.mint || "Mint pending";
    els.cluster.textContent = stream?.cluster === "devnet" ? "Solana devnet · test tokens" : stream?.cluster === "mainnet-beta" ? "Solana mainnet · real tokens" : "Not configured";
    els.review.textContent = els.amount.value || "0";
    els.state.textContent = !joined ? "Join a live room to send tokens." : stream?.message || (stream?.active ? "Stream is live." : "Waiting for an active stream.");
    els.send.disabled = busy || uncertain || !joined || !stream?.ready || !stream?.active || !address || !els.amount.value;
    els.connect.disabled = busy || Boolean(address);
    els.wallet.disabled = busy || Boolean(address);
    els.disconnect.disabled = busy || !address;
    els.amount.disabled = busy;
    els.checked.hidden = !uncertain;
  }

  async function request(path, options) {
    const response = await fetch(path, { cache: "no-store", ...options });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "The token request could not be completed.");
      error.signature = data.signature;
      throw error;
    }
    return data;
  }

  async function refresh() {
    const roomName = getRoom();
    const current = ++revision;
    if (!roomName) {
      stream = null;
      render();
      return;
    }
    try {
      const data = await request(`/api/streams/${encodeURIComponent(roomName)}`);
      if (current !== revision || getRoom() !== roomName) return;
      stream = data;
    } catch {
      if (current !== revision || getRoom() !== roomName) return;
      stream = { active: false, ready: false, message: "Stream status is unavailable. Sending is paused." };
    }
    render();
  }

  function resetWallet() {
    address = null;
    render();
  }

  function accountChanged(publicKey) {
    address = publicKey?.toBase58?.() || null;
    status(address ? "Wallet account changed. Review the recipient and amount before sending." : "Wallet disconnected.");
    render();
  }

  function removeListeners() {
    provider?.removeListener?.("accountChanged", accountChanged);
    provider?.removeListener?.("disconnect", resetWallet);
  }

  async function disconnect() {
    if (busy) return;
    removeListeners();
    const oldProvider = provider;
    provider = null;
    address = null;
    await Promise.resolve(oldProvider?.disconnect?.()).catch(() => {});
    status("Wallet disconnected.");
    render();
  }

  els.connect.addEventListener("click", async () => {
    const selected = els.wallet.value;
    const candidate = selected === "solflare" ? window.solflare : window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null);
    if (!candidate?.connect || !candidate?.signTransaction) {
      status(`Open this page in ${selected === "solflare" ? "Solflare" : "Phantom"}'s browser or install its browser extension, then connect again.`, "error");
      return;
    }
    busy = true;
    render();
    try {
      await candidate.connect();
      const key = candidate.publicKey?.toBase58?.();
      if (!key) throw new Error("The wallet did not provide a Solana address.");
      removeListeners();
      provider = candidate;
      address = key;
      provider.on?.("accountChanged", accountChanged);
      provider.on?.("disconnect", resetWallet);
      status("Wallet connected. Review the token, receiving address, network, and amount below.", "success");
    } catch (error) {
      status(error.code === 4001 ? "Wallet connection cancelled." : error.message || "Could not connect the wallet.", "error");
    } finally {
      busy = false;
      render();
    }
  });
  els.disconnect.addEventListener("click", disconnect);
  els.amount.addEventListener("input", render);
  els.checked.addEventListener("click", () => {
    uncertain = false;
    status("Review your wallet history and only send again if you intend another payment.");
    render();
  });

  function showReceipt(signature, cluster) {
    els.receipt.hidden = false;
    const url = new URL(`https://explorer.solana.com/tx/${encodeURIComponent(signature)}`);
    if (cluster === "devnet") url.searchParams.set("cluster", "devnet");
    els.receiptLink.href = url.toString();
    els.receiptLink.textContent = signature;
  }

  // Accept only the displayed SPL transfer plus its recipient-account creation.
  function validateTransaction(transaction, intent, expected) {
    for (const key of ["recipient", "mint", "cluster"]) {
      if (intent[key] !== expected[key]) throw new Error("Payment details changed. Review the current stream settings and try again.");
    }
    const sender = new PublicKey(expected.sender);
    const mint = new PublicKey(expected.mint);
    const recipient = new PublicKey(expected.recipient);
    const source = getAssociatedTokenAddressSync(mint, sender);
    const destination = getAssociatedTokenAddressSync(mint, recipient);
    if (!transaction.feePayer?.equals(sender) || transaction.signatures.length !== 1 || transaction.instructions.length !== 2) throw new Error("The wallet transaction does not match this payment.");
    const [create, transfer] = transaction.instructions;
    if (!create.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || create.data.length !== 1 || create.data[0] !== 1 ||
      create.keys.length !== 6 || !create.keys[0].pubkey.equals(sender) || !create.keys[1].pubkey.equals(destination) ||
      !create.keys[2].pubkey.equals(recipient) || !create.keys[3].pubkey.equals(mint) || !create.keys[4].pubkey.equals(SystemProgram.programId) || !create.keys[5].pubkey.equals(TOKEN_PROGRAM_ID)) {
      throw new Error("The receiving token account does not match the displayed wallet.");
    }
    const decoded = decodeTransferCheckedInstruction(transfer, TOKEN_PROGRAM_ID);
    const [whole, fraction = ""] = expected.amount.split(".");
    const decimals = decoded.data.decimals;
    if (!/^\d+(\.\d+)?$/.test(expected.amount) || fraction.length > decimals) throw new Error("Enter a valid token amount.");
    const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
    if (units <= 0n || decoded.data.amount !== units || !decoded.keys.source.pubkey.equals(source) || !decoded.keys.destination.pubkey.equals(destination) || !decoded.keys.mint.pubkey.equals(mint) || !decoded.keys.owner.pubkey.equals(sender)) {
      throw new Error("The transfer does not match the amount and recipient you reviewed.");
    }
  }

  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (els.send.disabled || busy) return;
    const roomName = getRoom();
    const selectedProvider = provider;
    const expected = { ...stream, sender: address, amount: els.amount.value.trim() };
    if (!/^\d+(\.\d+)?$/.test(expected.amount) || !/[1-9]/.test(expected.amount)) {
      status("Enter a token amount greater than zero without commas or exponent notation.", "error");
      return;
    }
    busy = true;
    let signedSignature = null;
    let submitted = false;
    els.receipt.hidden = true;
    status("Checking the live stream and preparing your payment…");
    render();
    try {
      const intent = await request("/api/tips/prepare", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ room: roomName, sender: expected.sender, amount: expected.amount }),
      });
      if (getRoom() !== roomName || address !== expected.sender || provider !== selectedProvider) throw new Error("Your room or wallet changed. Review the payment again.");
      const transaction = Transaction.from(Buffer.from(intent.transaction, "base64"));
      validateTransaction(transaction, intent, expected);
      status("Approve this token payment in your wallet. You also pay Solana fees and any receiving-account creation cost.");
      const reviewedMessage = Buffer.from(transaction.serializeMessage());
      const signed = await selectedProvider.signTransaction(transaction);
      if (getRoom() !== roomName || address !== expected.sender) throw new Error("Your room or wallet changed. The payment was not submitted.");
      if (!signed.signature || !Buffer.from(signed.serializeMessage()).equals(reviewedMessage)) throw new Error("The signed transaction changed. The payment was not submitted.");
      signedSignature = bs58.encode(signed.signature);
      const serialized = Buffer.from(signed.serialize()).toString("base64");
      showReceipt(signedSignature, expected.cluster);
      status("Payment submitted. Waiting for confirmation…");
      submitted = true;
      const result = await request("/api/tips/submit", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ intentId: intent.intentId, transaction: serialized }),
      });
      if (result.status !== "confirmed" || result.signature !== signedSignature) throw new Error("Payment confirmation could not be verified.");
      status("Your token payment is confirmed. Thank you for supporting the stream.", "success");
      els.amount.value = "";
    } catch (error) {
      if (submitted && signedSignature) {
        uncertain = true;
        showReceipt(signedSignature, expected.cluster);
        status(`${error.message || "Payment confirmation is unavailable."} Check the transaction link and your wallet history before trying again.`, "error");
      } else {
        status(error.code === 4001 ? "Payment cancelled in your wallet. Nothing was submitted by this app." : error.message || "The payment was not submitted.", "error");
      }
    } finally {
      busy = false;
      render();
      void refresh();
    }
  });

  render();
  setInterval(() => { if (getRoom() && !busy) void refresh(); }, 10_000);
  return { refresh, disconnect };
}
