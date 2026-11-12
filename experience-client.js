const CONTEXT = {
  coin: 'The coin · Story, official details, and launch readiness.',
  rewards: 'Juicy Journey · Care, Help, and Build through verified contributions.',
  live: 'Live lounge · Stream, watch, and chat in your room.',
  feed: 'Community feed · Browse photos or share a moment with your wallet.',
  tips: 'Tipping & wallet · Support the current host and review your wallet activity.',
  market: 'Market & activity · Official market data and recent community posts.',
};

export function initExperience({ onLeave }) {
  const $ = id => document.getElementById(id);
  const text = (id, value) => { if ($(id)) $(id).textContent = value; };
  let connected = false;
  let messages = 0;
  let unread = 0;
  let tips = 0;
  let liveView = 'split';
  let healthBusy = false;
  let stopped = false;

  function chatVisible() { return !$('panel-live').hidden && liveView !== 'video' && !document.hidden; }
  function updateChat() {
    if (chatVisible()) unread = 0;
    for (const id of ['dock-chat-count', 'nav-chat-count']) {
      $(id).hidden = !unread;
      $(id).textContent = unread > 99 ? '99+' : String(unread);
      $(id).setAttribute('aria-label', `${unread} unread chat messages`);
    }
    text('live-chat-summary', connected ? `${messages} ${messages === 1 ? 'message' : 'messages'} this visit` : 'Join a room to start chatting');
  }
  function setView(mode) {
    liveView = ['split', 'video', 'chat'].includes(mode) ? mode : 'split';
    $('live-room').dataset.view = liveView;
    for (const button of document.querySelectorAll('[data-live-view]')) button.setAttribute('aria-pressed', String(button.dataset.liveView === liveView));
    updateChat();
  }
  function openLive(mode) {
    document.querySelector('[data-panel="live"]').click();
    setView(mode);
    const target = mode === 'chat' ? document.querySelector('.chat-box') : document.querySelector('.stage-wrap');
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
    if (mode === 'chat' && connected) $('chat-input').focus({ preventScroll: true });
  }
  for (const button of document.querySelectorAll('[data-live-view]')) button.addEventListener('click', () => setView(button.dataset.liveView));
  $('dock-chat').addEventListener('click', () => openLive('chat'));
  $('dock-return').addEventListener('click', () => openLive('split'));
  $('dock-leave').addEventListener('click', onLeave);
  document.addEventListener('visibilitychange', updateChat);
  document.addEventListener('jcq:section', event => {
    text('section-context', CONTEXT[event.detail.key] || CONTEXT.coin);
    updateChat();
  });
  const initial = document.querySelector('[data-app-panel]:not([hidden])')?.dataset.appPanel || 'coin';
  text('section-context', CONTEXT[initial]);

  document.addEventListener('jcq:market', event => {
    const data = event.detail;
    text('market-state-summary', data.status === 'live' ? 'Live Solana market' : data.status === 'pending' ? 'Mint / market pending' : 'Temporarily unavailable');
    const time = new Date(data.updatedAt);
    text('market-updated-summary', data.status === 'live' && !Number.isNaN(time.getTime()) ? time.toLocaleTimeString() : 'No live price available');
  });
  document.addEventListener('jcq:feed', event => {
    const { count, more } = event.detail;
    text('feed-count-summary', `${count}${more ? '+' : ''} ${count === 1 && !more ? 'photo' : 'photos'} loaded`);
  });
  document.addEventListener('jcq:feed-error', () => text('feed-count-summary', 'Photos unavailable · try refreshing'));
  document.addEventListener('jcq:program', event => {
    const data = event.detail;
    text('rewards-status-summary', data.reviewReady ? 'Independent reviewer verification' : 'Reviewer setup pending');
    text('rewards-drops-summary', data.total === null ? 'Connect a wallet' : `${data.total} Spark ${data.total === 1 ? 'stamp' : 'stamps'}`);
  });
  async function checkHealth() {
    if (healthBusy || stopped || document.hidden) return;
    healthBusy = true;
    try {
      const response = await fetch('/healthz', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error();
      if (!stopped) text('server-state-summary', 'App server reachable');
    } catch { if (!stopped) text('server-state-summary', 'Connection unavailable · retrying'); }
    finally { healthBusy = false; }
  }
  checkHealth();
  const timer = setInterval(checkHealth, 30_000);
  window.addEventListener('pagehide', () => { stopped = true; clearInterval(timer); }, { once: true });

  return {
    config(config) {
      text('coin-ticker-summary', `$${config.coinSymbol || 'JCQ'} · intended`);
      text('coin-network-summary', config.network || 'Solana');
      text('coin-mint-summary', config.mint ? 'Configured · verify exact mint below' : 'Mint pending');
      text('feed-storage-summary', config.feedReady ? 'Public photo feed available' : 'Photo feed unavailable');
    },
    wallet(wallet) {
      const label = wallet?.address ? `${wallet.address.slice(0, 5)}…${wallet.address.slice(-5)}` : 'Not connected';
      text('tips-wallet-summary', label);
      text('feed-session-summary', wallet?.address ? label : 'Connect a wallet to post');
    },
    room(state = {}) {
      const wasConnected = connected;
      connected = Boolean(state.connected);
      if (!connected) { messages = 0; unread = 0; tips = 0; }
      else if (!wasConnected) { messages = 0; unread = 0; tips = 0; }
      $('room-dock').hidden = !connected;
      document.body.classList.toggle('has-room-dock', connected);
      const people = `${state.participants || 0} ${(state.participants || 0) === 1 ? 'person' : 'people'}`;
      text('live-members-summary', connected ? people : 'Not connected');
      const host = state.host ? `${state.host.name}${state.host.online ? '' : ' · offline'}` : 'No host designated';
      text('live-host-summary', connected ? host : 'Join a room to meet the host');
      text('tips-host-summary', connected ? host : 'Join a hosted room');
      text('dock-room', connected ? state.code : '');
      text('dock-participants', connected ? `${people} here` : '');
      text('dock-media', connected ? `Camera ${state.camera ? 'on' : 'off'} · Mic ${state.microphone ? 'on' : 'off'}` : '');
      text('tips-count-summary', `${tips} ${tips === 1 ? 'tip' : 'tips'}`);
      updateChat();
    },
    message({ mine }) {
      if (!connected) return;
      messages++;
      if (!mine && !chatVisible()) unread++;
      updateChat();
    },
    tip() {
      tips++;
      text('tips-count-summary', `${tips} ${tips === 1 ? 'tip' : 'tips'}`);
    },
  };
}
