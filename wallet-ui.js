import { getWallets } from '@wallet-standard/app';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { getMint, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { createTipTransaction, walletAddress } from './transactions.js';
import { parseAmount } from './amounts.js';

export function initWalletUI({ config, getRoom, send, onTip }) {
  const $ = (selector) => document.querySelector(selector);
  const registry = getWallets();
  const rpc = new Connection(new URL(config.payments.rpcPath, location.href).href, 'confirmed');
  const walletDialog = $('#wallet-dialog');
  const tipDialog = $('#tip-dialog');
  let connected = null;
  let unsubscribe = null;
  let review = null;
  let submitting = false;
  const short = (address) => `${address.slice(0, 5)}…${address.slice(-5)}`;
  const status = (selector, message, error = false) => {
    const element = $(selector);
    element.textContent = message;
    element.classList.toggle('error', error);
  };
  function explorer(signature) {
    return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${config.payments.cluster === 'devnet' ? '?cluster=devnet' : ''}`;
  }
  function setConnected(value) {
    connected = value;
    $('#wallet-label').textContent = value ? short(value.address) : 'Connect wallet';
    $('#disconnect-wallet').hidden = !value;
    update();
  }
  function providers(name) {
    const standard = registry.get().find((wallet) => wallet.name.toLowerCase().includes(name.toLowerCase())
      && wallet.features['standard:connect'] && (wallet.features['solana:signTransaction'] || wallet.features['solana:signAndSendTransaction']));
    if (standard) return { standard };
    if (name === 'Phantom') {
      const legacy = window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null);
      if (legacy) return { legacy };
    }
    return null;
  }
  async function connect(name) {
    status('#wallet-status', `Connecting to ${name}…`);
    try {
      const provider = providers(name);
      if (!provider) throw new Error(`${name} with Solana support was not detected. Open this page in its wallet browser or install its browser extension.`);
      let address, account;
      unsubscribe?.();
      if (provider.standard) {
        const wallet = provider.standard;
        const result = await wallet.features['standard:connect'].connect();
        account = result.accounts.find((item) => item.chains.includes(config.payments.chain));
        if (!account) throw new Error(`Choose a Solana account supporting ${config.payments.cluster} in ${name}. Ethereum accounts cannot send these tips.`);
        address = walletAddress(account.address);
        unsubscribe = wallet.features['standard:events']?.on('change', ({ accounts }) => {
          if (!accounts) return;
          const next = accounts.find((item) => item.chains.includes(config.payments.chain));
          if (!next) setConnected(null);
          else setConnected({ ...provider, account: next, address: walletAddress(next.address), name });
        });
      } else {
        const result = await provider.legacy.connect();
        address = walletAddress(result.publicKey.toString());
        const changed = (key) => setConnected(key ? { ...provider, address: walletAddress(key.toString()), name } : null);
        provider.legacy.on?.('accountChanged', changed);
        const disconnected = () => setConnected(null);
        provider.legacy.on?.('disconnect', disconnected);
        unsubscribe = () => {
          provider.legacy.removeListener?.('accountChanged', changed);
          provider.legacy.removeListener?.('disconnect', disconnected);
        };
      }
      setConnected({ ...provider, account, address, name });
      walletDialog.close();
      status('#wallet-status', 'Wallet connected. No funds have been sent.');
      status('#tip-status', 'Wallet connected. Choose an amount and review your tip.');
    } catch (error) { status('#wallet-status', error.code === 4001 ? 'Connection cancelled. You can try again whenever you like.' : error.message, true); }
  }
  function renderWallets() {
    $('#wallet-options').replaceChildren();
    for (const [name, symbol, url] of [['Phantom', '◒', 'https://phantom.com/'], ['MetaMask', '◈', 'https://metamask.io/']]) {
      const available = Boolean(providers(name));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wallet-choice';
      const mark = document.createElement('span'); mark.textContent = symbol;
      const label = document.createElement('span');
      const strong = document.createElement('strong'); strong.textContent = name;
      const small = document.createElement('small'); small.textContent = available ? 'Connect your Solana account' : 'Solana wallet not detected';
      label.append(strong, small); button.append(mark, label);
      button.addEventListener('click', () => connect(name));
      $('#wallet-options').append(button);
      if (!available) {
        const link = document.createElement('a');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'text-button';
        link.textContent = `Get ${name} ↗`; $('#wallet-options').append(link);
      }
    }
  }
  $('#connect-wallet').addEventListener('click', () => { renderWallets(); status('#wallet-status', ''); walletDialog.showModal(); });
  registry.on('register', renderWallets);
  registry.on('unregister', renderWallets);
  $('#disconnect-wallet').addEventListener('click', async () => {
    const prior = connected;
    unsubscribe?.(); unsubscribe = null; setConnected(null);
    try {
      if (prior?.standard) await prior.standard.features['standard:disconnect']?.disconnect();
      else await prior?.legacy?.disconnect?.();
    } catch {}
    walletDialog.close();
    status('#tip-status', 'Wallet disconnected.');
  });
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => {
    if (button.dataset.close !== 'tip-dialog' || !submitting) document.getElementById(button.dataset.close).close();
  });
  tipDialog.addEventListener('cancel', (event) => { if (submitting) event.preventDefault(); });
  $('#use-wallet').addEventListener('click', () => {
    if (!connected) { renderWallets(); walletDialog.showModal(); return; }
    $('#host-wallet').value = connected.address;
    status('#host-wallet-status', 'Check this address, then save it as your receiving wallet.');
  });
  $('#save-host-wallet').addEventListener('click', () => {
    try {
      const room = getRoom();
      if (!room?.isHost) throw new Error('Only the host can designate a receiving wallet.');
      const wallet = walletAddress($('#host-wallet').value);
      if (!send({ type: 'host-wallet', wallet })) throw new Error('Join your room before saving a wallet.');
      status('#host-wallet-status', 'Saving receiving wallet…');
    } catch (error) { status('#host-wallet-status', error.message, true); }
  });
  for (const button of document.querySelectorAll('[data-amount]')) button.addEventListener('click', () => {
    $('#tip-amount').value = button.dataset.amount;
    document.querySelectorAll('[data-amount]').forEach((item) => item.classList.toggle('selected', item === button));
  });
  $('#tip-asset').addEventListener('change', () => {
    const isJcq = $('#tip-asset').value === 'JCQ';
    [1, 5, 10].forEach((amount, i) => {
      const button = document.querySelectorAll('[data-amount]')[i];
      button.dataset.amount = String(isJcq ? amount : [0.005, 0.01, 0.05][i]);
      button.replaceChildren(document.createTextNode(button.dataset.amount));
      const small = document.createElement('small'); small.textContent = isJcq ? 'JCQ' : 'SOL'; button.append(small);
    });
    $('#tip-amount').value = isJcq ? '5' : '0.01';
  });
  function update() {
    const room = getRoom();
    const host = room?.host;
    const hosting = Boolean(room?.isHost);
    $('#host-settings').hidden = !hosting;
    if (hosting && host?.wallet) {
      $('#host-wallet').value = host.wallet;
      status('#host-wallet-status', 'Receiving wallet saved. Viewers see this address before approving a tip.');
    }
    $('#host-name').textContent = host?.name || 'Your lovely host';
    $('#host-state').textContent = !host ? 'Join a hosted room to send a tip' : !host.online ? 'Host is offline' : host.wallet ? 'Live · receiving wallet designated' : 'Live · receiving wallet not set';
    $('#payout-address').textContent = host?.wallet || 'Not designated yet';
    $('#review-tip').disabled = submitting || !connected || !host?.online || !host.wallet || connected.address === host.wallet;
    $('#jcq-option').disabled = !config.payments.mint;
    $('#jcq-option').textContent = config.payments.mint ? 'JCQ' : 'JCQ · coming soon';
    $('#tip-network').textContent = config.payments.cluster === 'devnet' ? 'SOLANA DEVNET · TEST' : 'SOLANA MAINNET';
  }
  $('#tip-form').addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const room = getRoom();
      const host = room?.host;
      if (!connected) { renderWallets(); walletDialog.showModal(); return; }
      if (!host?.online || !host.wallet) throw new Error('Join a live host with a designated receiving wallet first.');
      const asset = $('#tip-asset').value;
      if (asset === 'JCQ' && !config.payments.mint) throw new Error('JCQ transfers are not open yet. Official token details are coming.');
      const amount = $('#tip-amount').value.trim();
      parseAmount(amount, asset === 'SOL' ? 9 : 18);
      review = { host: { ...host }, asset, amount, sender: connected.address, roomCode: room.code };
      const panel = $('#tip-review'); panel.replaceChildren();
      const total = document.createElement('strong'); total.textContent = `${amount} ${asset}`;
      const hostLine = document.createElement('div'); hostLine.textContent = `For ${host.name}`;
      const address = document.createElement('code'); address.textContent = host.wallet; hostLine.append(address);
      const network = document.createElement('small'); network.textContent = `Network: Solana ${config.payments.cluster}. No platform fee. Network fees are additional.`;
      panel.append(total, hostLine, network);
      if (asset === 'JCQ') {
        const rent = document.createElement('small'); rent.textContent = "A new host token account may require an additional SOL rent deposit paid by you."; panel.append(rent);
      }
      status('#approval-status', ''); $('#approve-tip').disabled = false; tipDialog.showModal();
    } catch (error) { status('#tip-status', error.message, true); }
  });
  $('#approve-tip').addEventListener('click', async () => {
    if (submitting || !review) return;
    const current = getRoom();
    if (!connected || connected.address !== review.sender || current?.code !== review.roomCode || !current.host?.online
      || current.host.wallet !== review.host.wallet || current.host.revision !== review.host.revision) {
      status('#approval-status', 'The wallet, host, or receiving address changed. Close this review and check the tip again.', true); return;
    }
    submitting = true; $('#approve-tip').disabled = true; update();
    const payer = connected;
    let signature;
    try {
      status('#approval-status', 'Preparing the transaction on the displayed Solana network…');
      let decimals = 9;
      if (review.asset === 'JCQ') decimals = (await getMint(rpc, new PublicKey(config.payments.mint))).decimals;
      const recent = await rpc.getLatestBlockhash('confirmed');
      const transaction = createTipTransaction({ sender: payer.address, recipient: review.host.wallet, asset: review.asset,
        amount: review.amount, mint: config.payments.mint, decimals, blockhash: recent.blockhash });
      const balance = BigInt(await rpc.getBalance(new PublicKey(payer.address)));
      const fee = BigInt((await rpc.getFeeForMessage(transaction.compileMessage())).value ?? 5000);
      let required = fee;
      if (review.asset === 'SOL') required += parseAmount(review.amount, 9);
      else {
        const mint = new PublicKey(config.payments.mint);
        const source = getAssociatedTokenAddressSync(mint, new PublicKey(payer.address));
        const tokens = await rpc.getTokenAccountBalance(source);
        if (BigInt(tokens.value.amount) < parseAmount(review.amount, decimals)) throw new Error('This wallet does not have enough JCQ for that tip.');
        const target = getAssociatedTokenAddressSync(mint, new PublicKey(review.host.wallet));
        if (!await rpc.getAccountInfo(target)) required += BigInt(await rpc.getMinimumBalanceForRentExemption(165));
      }
      if (balance < required) throw new Error('This wallet needs more SOL for the tip and network fees.');
      if (connected !== payer) throw new Error('Your connected wallet changed. Review the tip again.');
      const now = getRoom();
      if (!now?.host?.online || now.host.wallet !== review.host.wallet || now.host.revision !== review.host.revision) throw new Error('The host receiving wallet changed. Review the tip again.');
      status('#approval-status', 'Review and approve this transfer in your wallet.');
      const unsigned = transaction.serialize({ requireAllSignatures: false });
      let signed;
      if (payer.standard?.features['solana:signTransaction']) {
        const [result] = await payer.standard.features['solana:signTransaction'].signTransaction({ transaction: unsigned, account: payer.account, chain: config.payments.chain });
        signed = Transaction.from(result.signedTransaction);
      } else if (payer.legacy?.signTransaction) signed = await payer.legacy.signTransaction(transaction);
      else {
        const [result] = await payer.standard.features['solana:signAndSendTransaction'].signAndSendTransaction({ transaction: unsigned, account: payer.account, chain: config.payments.chain });
        signature = bs58.encode(result.signature);
      }
      if (signed) {
        const latest = getRoom();
        if (!latest?.host?.online || latest.host.wallet !== review.host.wallet || latest.host.revision !== review.host.revision) throw new Error('The host receiving wallet changed while approving. No transfer was submitted; review the tip again.');
        const expected = transaction.serializeMessage(); const actual = signed.serializeMessage();
        if (expected.length !== actual.length || expected.some((byte, i) => byte !== actual[i]) || !signed.verifySignatures()) throw new Error('The wallet returned a different or unsigned transaction. No transfer was submitted.');
        signature = bs58.encode(signed.signature);
        const pendingReceipt = $('#tip-receipt'); pendingReceipt.href = explorer(signature); pendingReceipt.hidden = false;
        const submittedSignature = await rpc.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
        if (submittedSignature !== signature) throw new Error('The network returned a different receipt. Check your transaction before trying again.');
      }
      const receipt = $('#tip-receipt'); receipt.href = explorer(signature); receipt.hidden = false;
      status('#approval-status', 'Submitted. Waiting for Solana confirmation…');
      let confirmed = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await rpc.getSignatureStatus(signature);
        if (result.value?.err) throw new Error('The transaction failed on the network. Check the explorer receipt.');
        if (['confirmed', 'finalized'].includes(result.value?.confirmationStatus)) { confirmed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!confirmed) throw new Error('Confirmation is taking longer than expected. Check the receipt before sending another tip.');
      status('#tip-status', 'Tip confirmed on Solana. Thank you for sending a little love.');
      const sent = send({ type: 'tip-receipt', signature, recipient: review.host.wallet, asset: review.asset });
      if (!sent) status('#tip-status', 'Tip confirmed on Solana. Rejoin the room to continue; your explorer receipt is available.');
      tipDialog.close();
    } catch (error) {
      const message = error.code === 4001 ? 'Payment cancelled in your wallet. No new transfer was submitted.' : error.message;
      status('#approval-status', message, true);
      status('#tip-status', signature ? `${message} Check the existing receipt before retrying.` : message, true);
    } finally { submitting = false; $('#approve-tip').disabled = Boolean(signature); update(); }
  });
  update();
  return {
    update,
    confirmed(receipt) {
      const list = $('#tip-events'); list.querySelector('.activity-empty')?.remove();
      const row = document.createElement('li');
      const link = document.createElement('a'); link.href = explorer(receipt.signature); link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = `${short(receipt.sender)} sent ${receipt.amount} ${receipt.asset} ♡`; row.append(link); list.prepend(row);
      if (list.children.length > 20) list.lastElementChild.remove();
      if (connected?.address === receipt.sender) status('#tip-status', 'Tip confirmed and shared with the room. Thank you ♡');
      onTip(receipt);
    },
    error(message, scope = "host") { status(scope === "tip" ? "#tip-status" : "#host-wallet-status", message, true); },
  };
}
