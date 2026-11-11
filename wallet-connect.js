import { getWallets } from "@wallet-standard/app";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

const CHAIN = { "mainnet-beta": "solana:mainnet", devnet: "solana:devnet" };

function canonicalAddress(value) {
  if (typeof value !== "string") throw new Error("The wallet did not provide a Solana address.");
  const key = new PublicKey(value);
  if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes())) throw new Error("The wallet address is invalid.");
  return value;
}

function emitter() {
  const listeners = new Map();
  return {
    on(event, callback) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(callback); },
    removeListener(event, callback) { listeners.get(event)?.delete(callback); },
    emit(event, value) { for (const callback of listeners.get(event) || []) callback(value); },
  };
}

function messageBytes(transaction) {
  return transaction instanceof VersionedTransaction ? transaction.message.serialize() : transaction.serializeMessage();
}

function matchingMessage(original, signed) {
  const before = messageBytes(original);
  const after = messageBytes(signed);
  if (before.length !== after.length || before.some((value, index) => value !== after[index])) {
    throw new Error("The signed transaction changed. Nothing was submitted by this app.");
  }
}

function supportedAccount(account, chain) {
  return account?.chains?.includes(chain) && account.features?.includes("solana:signTransaction");
}

// Wallet Standard covers installed compatible Solana wallets. Injected adapters
// retain support for Phantom and Solflare browsers that have not registered yet.
export function createWalletRegistry({ getCluster, target = globalThis.window, registry = getWallets() }) {
  const changed = new Set();
  const standard = new WeakMap();
  let nextId = 1;

  function standardAdapter(wallet) {
    if (standard.has(wallet)) return standard.get(wallet);
    const events = emitter();
    let account = null;
    let stopChanges = null;
    const adapter = {
      id: `standard-${nextId++}`,
      name: wallet.name,
      get publicKey() { return account ? new PublicKey(account.address) : null; },
      get canSignMessage() { return Boolean(account?.features.includes("solana:signMessage") && wallet.features["solana:signMessage"]); },
      async connect() {
        const chain = CHAIN[getCluster()];
        if (!chain) throw new Error("Wallet network settings are unavailable. Reload the app.");
        const result = await wallet.features["standard:connect"].connect();
        account = (result.accounts || wallet.accounts || []).find((item) => supportedAccount(item, chain)) || null;
        if (!account) throw new Error("This wallet has no signing account for the app's Solana network.");
        canonicalAddress(account.address);
        stopChanges?.();
        stopChanges = wallet.features["standard:events"].on("change", (change) => {
          if (!change.accounts) return;
          const candidates = change.accounts.filter((item) => supportedAccount(item, CHAIN[getCluster()]));
          account = candidates.find((item) => item.address === account?.address) || candidates[0] || null;
          try { if (account) canonicalAddress(account.address); } catch { account = null; }
          if (!account) events.emit("disconnect");
          else events.emit("accountChanged", new PublicKey(account.address));
        });
        return { address: account.address };
      },
      async disconnect() {
        stopChanges?.(); stopChanges = null; account = null;
        await wallet.features["standard:disconnect"]?.disconnect();
      },
      async signTransaction(transaction) {
        const selected = account;
        const chain = CHAIN[getCluster()];
        if (!selected || !supportedAccount(selected, chain)) throw new Error("Reconnect your wallet on the selected Solana network.");
        const feature = wallet.features["solana:signTransaction"];
        const version = transaction instanceof VersionedTransaction ? transaction.version : "legacy";
        if (!feature.supportedTransactionVersions?.includes(version)) throw new Error("This wallet cannot sign this transaction format. Choose a compatible wallet.");
        const bytes = transaction instanceof VersionedTransaction ? transaction.serialize() : transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
        const [result] = await feature.signTransaction({ transaction: new Uint8Array(bytes), account: selected, chain });
        if (account !== selected || CHAIN[getCluster()] !== chain) throw new Error("Your wallet account or network changed. Review the transaction again.");
        const signed = transaction instanceof VersionedTransaction ? VersionedTransaction.deserialize(result.signedTransaction) : Transaction.from(result.signedTransaction);
        matchingMessage(transaction, signed);
        return signed;
      },
      on: events.on,
      removeListener: events.removeListener,
    };
    if (wallet.features["solana:signMessage"]) adapter.signMessage = async (message) => {
      const selected = account;
      if (!selected?.features.includes("solana:signMessage")) throw new Error("This wallet account cannot sign messages.");
      const [result] = await wallet.features["solana:signMessage"].signMessage({ message, account: selected });
      if (account !== selected) throw new Error("Your wallet account changed. Sign in again.");
      if (!(result.signature instanceof Uint8Array) || result.signature.length !== 64) throw new Error("The wallet returned an invalid message signature.");
      return result.signature;
    };
    standard.set(wallet, adapter);
    return adapter;
  }

  function injectedAdapter(id, name, resolve) {
    let source = null;
    const adapter = {
      id, name,
      get publicKey() { return source?.publicKey || null; },
      async connect() {
        source = resolve();
        if (!source?.connect || !source?.signTransaction) throw new Error(`Open this app in ${name}'s browser or install its extension, then connect again.`);
        await source.connect();
        return { address: canonicalAddress(source.publicKey?.toBase58?.()) };
      },
      async disconnect() { await source?.disconnect?.(); source = null; },
      async signTransaction(transaction) {
        const selected = source;
        const address = canonicalAddress(selected?.publicKey?.toBase58?.());
        const before = new Uint8Array(messageBytes(transaction));
        const signed = await selected.signTransaction(transaction);
        if (source !== selected || selected.publicKey?.toBase58?.() !== address) throw new Error("Your wallet account changed. Review the transaction again.");
        const after = messageBytes(signed);
        if (before.length !== after.length || before.some((value, index) => value !== after[index])) throw new Error("The signed transaction changed. Nothing was submitted by this app.");
        return signed;
      },
      on(event, callback) { source?.on?.(event, callback); },
      removeListener(event, callback) { source?.removeListener?.(event, callback); },
      get canSignMessage() { return typeof source?.signMessage === "function"; },
      async signMessage(message) {
        const selected = source;
        const address = canonicalAddress(selected?.publicKey?.toBase58?.());
        if (!selected?.signMessage) throw new Error("This wallet cannot sign messages. Choose a compatible wallet to post images.");
        const result = await selected.signMessage(message, "utf8");
        if (source !== selected || selected.publicKey?.toBase58?.() !== address) throw new Error("Your wallet account changed. Sign in again.");
        const signature = result?.signature || result;
        if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error("The wallet returned an invalid message signature.");
        return signature;
      },
    };
    return adapter;
  }

  const fallback = [
    injectedAdapter("phantom", "Phantom", () => target?.phantom?.solana || (target?.solana?.isPhantom ? target.solana : null)),
    injectedAdapter("solflare", "Solflare", () => target?.solflare),
  ];
  function list() {
    return [...fallback, ...registry.get().filter((wallet) => wallet?.features?.["standard:connect"] && wallet.features["standard:events"] && wallet.features["solana:signTransaction"]).map(standardAdapter)];
  }
  const notify = () => { for (const callback of changed) callback(list()); };
  const offRegister = registry.on("register", notify);
  const offUnregister = registry.on("unregister", notify);
  return {
    list,
    subscribe(callback) { changed.add(callback); callback(list()); return () => changed.delete(callback); },
    dispose() { offRegister(); offUnregister(); changed.clear(); },
  };
}
