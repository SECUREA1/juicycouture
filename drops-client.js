import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Buffer } from "buffer";
import bs58 from "bs58";

const LIMITS = { breakfast: 200n, helping: 500n, builder: 1000n };
const TIER_NAMES = {
  breakfast: "Breakfast Bloom",
  helping: "Helping Hands / Good Vibes",
  builder: "Community Builder",
};
const LABELS = {
  draft: "Awaiting host approval",
  approved: "Recipients approved",
  prepared: "Payout prepared",
  submitted: "Confirmation pending",
  pending: "Confirmation pending",
  paid: "Paid",
  confirmed: "Paid",
  failed: "Payout failed",
  expired: "Prepared payout expired",
};

function units(value, decimals) {
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(value) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  )
    throw new Error("The drop contains an invalid amount.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new Error("The drop contains an invalid amount precision.");
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  );
}

function address(value) {
  if (typeof value !== "string")
    throw new Error("Use a full Solana wallet address.");
  const key = new PublicKey(value);
  if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes()))
    throw new Error("Use a valid Solana wallet address.");
  return key;
}

// Hosts approve the gathering and recipients. Every payout still requires the
// funding wallet's transaction signature; browsing never signs or sends tokens.
export function initDrops({
  getWallet,
  subscribe,
  withWalletLock,
  onConfirmed,
}) {
  const $ = (id) => document.getElementById(id);
  const els = {
    list: $("drop-list"),
    status: $("drop-status"),
    panel: $("drop-host-panel"),
    createForm: $("drop-create-form"),
    code: $("drop-event-code"),
    title: $("drop-title"),
    price: $("drop-cad-price"),
    kind: $("drop-kind"),
    create: $("drop-create"),
    approveForm: $("drop-approve-form"),
    select: $("drop-select"),
    recipient: $("drop-recipient"),
    tier: $("drop-tier"),
    cad: $("drop-cad-amount"),
    approve: $("drop-approve"),
    review: $("drop-payout-review"),
    prepare: $("drop-prepare"),
    send: $("drop-send"),
    hostStatus: $("drop-host-status"),
    receipt: $("drop-receipt"),
    receiptLink: $("drop-receipt-link"),
  };
  let settings = null;
  let drops = [];
  let busy = false;
  let loading = false;
  let destroyed = false;
  let revision = 0;
  let walletIdentity = "";
  let reviewed = null;
  let uncertain = null;
  let expiryNotified = false;

  const setStatus = (element, message, kind = "pending") => {
    element.textContent = message;
    element.className = `status ${kind}`;
  };
  async function request(path, body) {
    const response = await fetch(path, {
      cache: "no-store",
      ...(body
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(
        "The token drop service returned an unreadable response. Please try again later.",
      );
    }
    if (!response.ok) {
      const error = new Error(
        result.error || "The token drop could not be completed.",
      );
      error.signature = result.signature;
      throw error;
    }
    return result;
  }
  function isHost(wallet = getWallet()) {
    return Boolean(
      wallet &&
        settings?.hosts?.includes(wallet.address) &&
        wallet.cluster === settings.cluster,
    );
  }
  function selectedDrop() {
    return drops.find((drop) => String(drop.id) === els.select.value);
  }
  function canEdit(drop) {
    return drop && ["draft", "approved"].includes(drop.status);
  }
  function stillCurrent(wallet, expectedRevision) {
    const current = getWallet();
    if (
      destroyed ||
      expectedRevision !== revision ||
      current?.address !== wallet.address ||
      current?.cluster !== wallet.cluster ||
      !isHost(current)
    )
      throw new Error(
        "Your wallet or drop details changed. Review the action again.",
      );
  }
  function receipt(signature, cluster) {
    if (!signature) return;
    const url = new URL(
      `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`,
    );
    if (cluster === "devnet") url.searchParams.set("cluster", "devnet");
    els.receipt.hidden = false;
    els.receiptLink.href = url.toString();
    els.receiptLink.textContent = signature;
  }
  function text(tag, content, className) {
    const element = document.createElement(tag);
    element.textContent = content;
    if (className) element.className = className;
    return element;
  }
  function render() {
    const wallet = getWallet();
    const host = isHost(wallet);
    els.panel.hidden = !host;
    const ready =
      host && settings?.ready && typeof wallet.signMessage === "function";
    const drop = selectedDrop();
    els.create.disabled = busy || loading || !ready || Boolean(uncertain);
    els.approve.disabled =
      busy || loading || !ready || !canEdit(drop) || Boolean(uncertain);
    els.prepare.disabled =
      busy ||
      loading ||
      !ready ||
      !drop ||
      !["approved", "prepared"].includes(drop.status) ||
      Boolean(uncertain);
    els.send.disabled =
      busy ||
      loading ||
      !ready ||
      !reviewed ||
      reviewed.expiresAt <= Date.now() ||
      reviewed.sender !== wallet?.address ||
      Boolean(uncertain);
    for (const input of [
      els.code,
      els.title,
      els.price,
      els.kind,
      els.select,
      els.recipient,
      els.tier,
      els.cad,
    ])
      if (input) input.disabled = busy || !ready;
    if (host && !settings?.ready && !busy)
      setStatus(
        els.hostStatus,
        settings?.message ||
          "Token drops need the project mint and reward host setup before payouts can start.",
      );
    else if (host && typeof wallet.signMessage !== "function" && !busy)
      setStatus(
        els.hostStatus,
        "Choose a wallet that supports message signing to manage token drops.",
      );
    if (reviewed) renderReview();
  }
  function renderReview() {
    els.review.replaceChildren();
    if (!reviewed) return;
    els.review.append(text("h4", "Review the approved token drop"));
    els.review.append(text("p", `Funding wallet: ${reviewed.sender}`));
    els.review.append(text("p", `Token mint: ${reviewed.mint}`));
    els.review.append(
      text(
        "p",
        `Network: ${reviewed.cluster === "devnet" ? "Solana devnet · test tokens" : "Solana mainnet · real tokens"}`,
      ),
    );
    els.review.append(
      text(
        "p",
        `Host-entered value: CAD ${reviewed.cadPerToken} per token. Total: ${reviewed.totalTokens} tokens.`,
      ),
    );
    const recipients = document.createElement("ul");
    for (const item of reviewed.recipients)
      recipients.append(
        text(
          "li",
          `${item.wallet} — ${item.tokenAmount} tokens · CAD ${item.cadAmount} · ${TIER_NAMES[item.tier] || item.tier}`,
        ),
      );
    els.review.append(
      recipients,
      text(
        "p",
        "Only the highest approved tier applies to each person in this gathering. The funding wallet pays SOL fees and any receiving token-account creation costs.",
      ),
    );
    els.review.append(
      text(
        "p",
        reviewed.expiresAt > Date.now()
          ? "Review all recipients and amounts, then approve the payout in your wallet."
          : "This prepared payout expired. Review it again before signing.",
      ),
    );
  }
  function renderList() {
    document.dispatchEvent(new CustomEvent('jcq:drops', { detail: { count: drops.length } }));
    els.list.replaceChildren();
    if (!drops.length)
      els.list.append(
        text(
          "p",
          "No token drops are scheduled yet. Approved jobs, gatherings, and their payouts will appear here.",
          "drop-empty",
        ),
      );
    for (const drop of drops) {
      const card = document.createElement("article");
      card.className = "drop-card";
      card.append(
        text("h4", drop.title || "Community reward"),
        text(
          "p",
          `${drop.kind === "job" ? "Approved job" : "Gathering"} · ${drop.eventCode} · ${LABELS[drop.status] || "Awaiting review"}`,
          "drop-state",
        ),
      );
      card.append(
        text(
          "p",
          `Host-entered value: CAD ${drop.cadPerToken} per token. Highest approved tier only; rewards do not stack.`,
        ),
      );
      const recipients = Array.isArray(drop.recipients) ? drop.recipients : [];
      if (!recipients.length)
        card.append(text("p", "Recipients have not been approved yet."));
      else {
        const list = document.createElement("ul");
        for (const item of recipients)
          list.append(
            text(
              "li",
              `${item.wallet} · ${TIER_NAMES[item.tier] || "Approved reward"} · CAD ${item.cadAmount}${item.tokenAmount ? ` · ${item.tokenAmount} tokens` : ""}`,
            ),
          );
        card.append(list);
      }
      if (drop.signature) {
        const link = document.createElement("a");
        const explorer = new URL(
          `https://explorer.solana.com/tx/${encodeURIComponent(drop.signature)}`,
        );
        if (drop.cluster === "devnet")
          explorer.searchParams.set("cluster", "devnet");
        link.href = explorer.toString();
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "View payout transaction";
        card.append(link);
      }
      if (
        drop.intentId &&
        ["prepared", "submitted", "pending"].includes(drop.status) &&
        drop.owner === getWallet()?.address
      ) {
        const check = text("button", "Check payout status", "small-button");
        check.type = "button";
        check.disabled = busy || loading;
        check.addEventListener("click", () => {
          void checkStatus(drop.intentId);
        });
        card.append(check);
      }
      els.list.append(card);
    }
    const previous = els.select.value;
    const mine = drops.filter(
      (drop) =>
        drop.owner === getWallet()?.address &&
        !["paid", "confirmed"].includes(drop.status),
    );
    els.select.replaceChildren(
      ...mine.map((drop) => {
        const option = document.createElement("option");
        option.value = String(drop.id);
        option.textContent = `${drop.title} · ${LABELS[drop.status] || drop.status}`;
        return option;
      }),
    );
    if (mine.some((drop) => String(drop.id) === previous))
      els.select.value = previous;
    render();
  }
  async function load() {
    if (loading || destroyed) return;
    loading = true;
    render();
    try {
      const result = await request("/api/drops");
      if (!Array.isArray(result.drops))
        throw new Error("The token drop schedule could not be loaded.");
      if (destroyed) return;
      drops = result.drops;
      setStatus(
        els.status,
        drops.length
          ? "Host-approved job and gathering rewards and their payout status."
          : "Token drops will appear after a host approves a job or gathering.",
      );
      renderList();
    } catch (error) {
      if (!destroyed) document.dispatchEvent(new CustomEvent('jcq:drops-error'));
      if (!destroyed)
        setStatus(
          els.status,
          error.message || "The token drop schedule is unavailable.",
          "error",
        );
    } finally {
      loading = false;
      if (!destroyed) render();
    }
  }
  function invalidate() {
    revision++;
    reviewed = null;
    expiryNotified = false;
    els.review.replaceChildren();
    render();
  }
  async function signedAction(action, payload, wallet, expectedRevision) {
    stillCurrent(wallet, expectedRevision);
    if (typeof wallet.signMessage !== "function")
      throw new Error("The host wallet must support message signing.");
    const challenge = await request("/api/drops/challenge", {
      wallet: wallet.address,
      action,
      payload,
    });
    stillCurrent(wallet, expectedRevision);
    if (
      typeof challenge.challengeId !== "string" ||
      typeof challenge.message !== "string" ||
      !challenge.message.includes(wallet.address)
    )
      throw new Error("The token drop approval request could not be verified.");
    setStatus(
      els.hostStatus,
      "Approve the token drop action message in your host wallet. This message does not transfer tokens.",
    );
    const signature = await wallet.signMessage(
      new TextEncoder().encode(challenge.message),
    );
    stillCurrent(wallet, expectedRevision);
    if (!(signature instanceof Uint8Array) || signature.length !== 64)
      throw new Error(
        "The host wallet returned an invalid approval signature.",
      );
    return request(`/api/drops/${action}`, {
      challengeId: challenge.challengeId,
      signature: bs58.encode(signature),
    });
  }
  async function manage(action, payload, success) {
    if (busy || loading || uncertain) return;
    const wallet = getWallet();
    if (!isHost(wallet) || !settings.ready) return;
    invalidate();
    const current = revision;
    busy = true;
    render();
    try {
      const result = await signedAction(action, payload, wallet, current);
      stillCurrent(wallet, current);
      setStatus(els.hostStatus, success, "success");
      await load();
      if (
        result.id &&
        [...els.select.options].some(
          (option) => option.value === String(result.id),
        )
      )
        els.select.value = String(result.id);
      return result;
    } catch (error) {
      setStatus(
        els.hostStatus,
        error.code === 4001
          ? "Host approval cancelled. No tokens were sent."
          : error.message || "The token drop action could not be completed.",
        "error",
      );
    } finally {
      busy = false;
      render();
    }
  }
  els.createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const price = els.price.value.trim();
    try {
      if (units(price, 18) <= 0n)
        throw new Error("Enter a positive CAD value per token.");
    } catch (error) {
      return setStatus(els.hostStatus, error.message, "error");
    }
    void manage(
      "create",
      {
        eventCode: els.code.value.trim().toLowerCase(),
        title: els.title.value.trim(),
        cadPerToken: price,
        kind: els.kind?.value === "job" ? "job" : "gathering",
      },
      "The reward drop is scheduled. Approve its verified recipients next; no tokens have been sent.",
    );
  });
  els.approveForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      address(els.recipient.value.trim());
      const amount = units(els.cad.value.trim(), 2);
      if (
        !LIMITS[els.tier.value] ||
        amount <= 0n ||
        amount > LIMITS[els.tier.value]
      )
        throw new Error(
          "Choose a positive amount within the selected tier's CAD cap.",
        );
    } catch (error) {
      return setStatus(els.hostStatus, error.message, "error");
    }
    void manage(
      "approve",
      {
        dropId: els.select.value,
        recipients: [
          {
            wallet: els.recipient.value.trim(),
            tier: els.tier.value,
            cadAmount: els.cad.value.trim(),
          },
        ],
      },
      "Recipient approved and reward allocation queued. The highest eligible tier applies; amounts do not stack. Review the token drop to approve payment.",
    );
  });

  function verifyPrepared(intent, wallet) {
    if (
      typeof intent.intentId !== "string" ||
      typeof intent.transaction !== "string" ||
      intent.transaction.length > 1700 ||
      intent.sender !== wallet.address ||
      intent.mint !== settings.mint ||
      intent.cluster !== wallet.cluster ||
      !Number.isFinite(intent.expiresAt) ||
      intent.expiresAt <= Date.now() ||
      !Number.isInteger(intent.decimals) ||
      intent.decimals < 0 ||
      intent.decimals > 255 ||
      !Array.isArray(intent.recipients) ||
      !intent.recipients.length ||
      intent.recipients.length > 5
    )
      throw new Error(
        "The prepared payout does not match the host wallet or token settings.",
      );
    const sender = address(wallet.address),
      mint = new PublicKey(intent.mint);
    const source = getAssociatedTokenAddressSync(mint, sender);
    const transaction = Transaction.from(
      Buffer.from(intent.transaction, "base64"),
    );
    if (
      !transaction.feePayer?.equals(sender) ||
      transaction.signatures.length !== 1 ||
      transaction.signatures[0].publicKey.toBase58() !== wallet.address ||
      transaction.signatures[0].signature ||
      transaction.instructions.length !== intent.recipients.length * 2
    )
      throw new Error(
        "The prepared transaction does not match the reviewed drop.",
      );
    const seen = new Set();
    let total = 0n;
    const priceDecimals = intent.cadPerToken?.split(".")[1]?.length || 0;
    if (priceDecimals > 18)
      throw new Error("The token drop's CAD price is invalid.");
    const priceUnits = units(intent.cadPerToken, priceDecimals);
    if (priceUnits <= 0n)
      throw new Error("The token drop's CAD price is invalid.");
    intent.recipients.forEach((recipient, index) => {
      const target = address(recipient.wallet);
      if (seen.has(recipient.wallet) || target.equals(sender))
        throw new Error(
          "The payout contains a duplicate or invalid recipient.",
        );
      seen.add(recipient.wallet);
      const cad = units(recipient.cadAmount, 2);
      if (!LIMITS[recipient.tier] || cad <= 0n || cad > LIMITS[recipient.tier])
        throw new Error("The payout exceeds a reward tier's CAD cap.");
      const amount = units(recipient.tokenAmount, intent.decimals);
      if (
        amount <= 0n ||
        amount > (1n << 64n) - 1n ||
        amount !==
          (cad *
            10n ** BigInt(priceDecimals) *
            10n ** BigInt(intent.decimals)) /
            (priceUnits * 100n)
      )
        throw new Error(
          "The payout's token amount does not match the approved CAD amount and price.",
        );
      if (
        recipient.tokenBaseUnits !== undefined &&
        recipient.tokenBaseUnits !== amount.toString()
      )
        throw new Error("The payout contains inconsistent token amounts.");
      total += amount;
      const destination = getAssociatedTokenAddressSync(mint, target);
      const [create, transfer] = transaction.instructions.slice(
        index * 2,
        index * 2 + 2,
      );
      if (
        !create.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) ||
        create.data.length !== 1 ||
        create.data[0] !== 1 ||
        create.keys.length !== 6 ||
        !create.keys[0].pubkey.equals(sender) ||
        !create.keys[1].pubkey.equals(destination) ||
        !create.keys[2].pubkey.equals(target) ||
        !create.keys[3].pubkey.equals(mint) ||
        !create.keys[4].pubkey.equals(SystemProgram.programId) ||
        !create.keys[5].pubkey.equals(TOKEN_PROGRAM_ID) ||
        transfer.keys.length !== 4
      )
        throw new Error("A payout instruction does not match its recipient.");
      const decoded = decodeTransferCheckedInstruction(
        transfer,
        TOKEN_PROGRAM_ID,
      );
      if (
        decoded.data.amount !== amount ||
        decoded.data.decimals !== intent.decimals ||
        !decoded.keys.source.pubkey.equals(source) ||
        !decoded.keys.destination.pubkey.equals(destination) ||
        !decoded.keys.mint.pubkey.equals(mint) ||
        !decoded.keys.owner.pubkey.equals(sender)
      )
        throw new Error(
          "A payout transfer differs from the reviewed token drop.",
        );
    });
    if (
      total !== units(intent.totalTokens, intent.decimals) ||
      (intent.totalBaseUnits !== undefined &&
        intent.totalBaseUnits !== total.toString())
    )
      throw new Error("The payout total differs from its recipients.");
    return transaction;
  }

  els.prepare.addEventListener("click", async () => {
    if (els.prepare.disabled || busy) return;
    const wallet = getWallet(),
      dropId = els.select.value;
    invalidate();
    const current = revision;
    busy = true;
    render();
    try {
      const result = await signedAction("prepare", { dropId }, wallet, current);
      stillCurrent(wallet, current);
      if (String(result.dropId) !== dropId)
        throw new Error("The prepared payout belongs to another gathering.");
      verifyPrepared(result, wallet);
      reviewed = result;
      setStatus(
        els.hostStatus,
        "Review every recipient, amount, and the host-entered token price. Choose Approve payout in wallet to send.",
        "success",
      );
      await load();
    } catch (error) {
      setStatus(
        els.hostStatus,
        error.code === 4001
          ? "Payout preparation cancelled. No tokens were sent."
          : error.message || "The payout could not be prepared.",
        "error",
      );
    } finally {
      busy = false;
      render();
    }
  });
  els.send.addEventListener("click", async () => {
    if (els.send.disabled || busy || !reviewed || uncertain) return;
    const intent = reviewed,
      current = revision;
    busy = true;
    let submitted = false,
      signature = null;
    render();
    try {
      await withWalletLock(async (wallet) => {
        stillCurrent(wallet, current);
        if (intent.expiresAt <= Date.now())
          throw new Error(
            "The prepared drop expired. Review it again before sending.",
          );
        const transaction = verifyPrepared(intent, wallet);
        const message = Buffer.from(transaction.serializeMessage());
        setStatus(
          els.hostStatus,
          "Approve the reviewed payout in your funding wallet. SOL fees also apply.",
        );
        const signed = await wallet.signTransaction(transaction);
        stillCurrent(wallet, current);
        if (intent.expiresAt <= Date.now())
          throw new Error(
            "The prepared drop expired. The payout was not submitted.",
          );
        if (
          !signed.signature ||
          !Buffer.from(signed.serializeMessage()).equals(message) ||
          !signed.verifySignatures()
        )
          throw new Error(
            "The signed payout changed or does not belong to your wallet. Nothing was submitted.",
          );
        signature = bs58.encode(signed.signature);
        const encoded = Buffer.from(signed.serialize()).toString("base64");
        receipt(signature, intent.cluster);
        submitted = true;
        setStatus(
          els.hostStatus,
          "Payout submitted. Waiting for Solana confirmation…",
        );
        const result = await request("/api/drops/submit", {
          intentId: intent.intentId,
          transaction: encoded,
        });
        if (result.status !== "confirmed" || result.signature !== signature)
          throw new Error("Payout confirmation could not be verified.");
      });
      reviewed = null;
      els.review.replaceChildren();
      setStatus(
        els.hostStatus,
        "The approved token drop is confirmed. Recipients were paid once for this job or gathering.",
        "success",
      );
      Promise.resolve(onConfirmed?.()).catch(() => {});
    } catch (error) {
      if (submitted && signature) {
        uncertain = {
          intentId: intent.intentId,
          signature,
          cluster: intent.cluster,
        };
        receipt(signature, intent.cluster);
        setStatus(
          els.hostStatus,
          `${error.message || "Confirmation is unavailable."} Check payout status and the transaction before attempting another payout.`,
          "error",
        );
      } else
        setStatus(
          els.hostStatus,
          error.code === 4001
            ? "Payout cancelled in your wallet. Nothing was submitted by this app."
            : error.message || "The payout was not submitted.",
          "error",
        );
    } finally {
      busy = false;
      render();
      await load();
    }
  });
  async function checkStatus(intentId) {
    if (busy || loading) return;
    busy = true;
    render();
    try {
      const result = await request(
        `/api/drops/status/${encodeURIComponent(intentId)}`,
      );
      if (result.signature)
        receipt(result.signature, result.cluster || settings?.cluster);
      if (["confirmed", "failed", "expired"].includes(result.status)) {
        if (uncertain?.intentId === intentId) uncertain = null;
        reviewed = null;
        els.review.replaceChildren();
      }
      setStatus(
        els.hostStatus,
        result.status === "confirmed"
          ? "The token drop is confirmed. No repeat payout is needed."
          : result.status === "failed"
            ? "Solana reports that the payout failed. Network fees may still apply. Review the transaction before continuing."
            : result.status === "expired"
              ? "The prepared payout expired. It can be reviewed again once the network confirms that the old transaction is no longer valid. Refresh status if review is still unavailable."
              : result.status === "prepared"
                ? "The payout is prepared and has not been submitted by this app. Review it before approving in your wallet."
                : "Confirmation is still pending. Do not send another payout for these recipients.",
        result.status === "confirmed" ? "success" : "pending",
      );
    } catch (error) {
      setStatus(
        els.hostStatus,
        error.message ||
          "Payout status is unavailable. Keep the transaction signature and check again later.",
        "error",
      );
    } finally {
      busy = false;
      await load();
      render();
    }
  }
  const statusButton = text("button", "Refresh payout status", "small-button");
  statusButton.type = "button";
  statusButton.hidden = true;
  statusButton.addEventListener("click", () => {
    if (uncertain) void checkStatus(uncertain.intentId);
  });
  els.receipt.after(statusButton);
  const renderBase = render;
  // Keep the persistent pending-state recovery action separate from approval.
  const timer = setInterval(() => {
    statusButton.hidden = !uncertain;
    statusButton.disabled = busy || loading;
    if (
      reviewed &&
      reviewed.expiresAt <= Date.now() &&
      !expiryNotified &&
      !busy
    ) {
      expiryNotified = true;
      setStatus(
        els.hostStatus,
        "The prepared payout expired. Review it again before signing.",
      );
      renderBase();
    }
  }, 1000);
  for (const input of [
    els.code,
    els.title,
    els.price,
    els.kind,
    els.select,
    els.recipient,
    els.tier,
    els.cad,
  ]) {
    if (!input) continue;
    input.addEventListener("input", () => {
      if (!busy) invalidate();
    });
    if (input.tagName === "SELECT")
      input.addEventListener("change", () => {
        if (!busy) invalidate();
      });
  }
  els.tier.addEventListener("change", () => {
    if (busy) return;
    els.cad.value = ((LIMITS[els.tier.value] || 0n) / 100n).toString();
    invalidate();
  });
  const unsubscribe = subscribe((wallet) => {
    const identity = wallet ? `${wallet.address}:${wallet.cluster}` : "";
    if (identity !== walletIdentity) {
      walletIdentity = identity;
      invalidate();
      renderList();
    }
  });
  void request("/api/drops/config")
    .then((result) => {
      if (destroyed) return;
      settings = result;
      renderList();
      return load();
    })
    .catch(() => {
      if (!destroyed)
        setStatus(
          els.status,
          "The token drop schedule is unavailable. Please try again later.",
          "error",
        );
    });
  return {
    refresh: load,
    destroy() {
      destroyed = true;
      revision++;
      clearInterval(timer);
      unsubscribe?.();
    },
  };
}
