export function initTickers() {
  const market = document.querySelector('#market-feed');
  const activity = document.querySelector('#activity-track');
  const pause = document.querySelector('#pause-activity');
  let stopped = false;
  pause.addEventListener('click', () => {
    const paused = pause.getAttribute('aria-pressed') !== 'true';
    pause.setAttribute('aria-pressed', String(paused));
    pause.textContent = paused ? 'Resume ticker' : 'Pause ticker';
    activity.classList.toggle('paused', paused);
  });
  const number = (value, currency = true) => {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return 'Unavailable';
    return new Intl.NumberFormat('en-US', currency ? { style: 'currency', currency: 'USD', maximumSignificantDigits: 6 } : { maximumFractionDigits: 2 }).format(Number(value));
  };
  function updateCoinMarket(data) {
    document.dispatchEvent(new CustomEvent('jcq:market', { detail: data }));
    const status = document.querySelector('#market-status');
    if (!status) return;
    status.textContent = data.status === 'live' ? 'USD · Market data may be delayed. Updated automatically every 30 seconds.' : data.message || 'Market data is temporarily unavailable.';
    const values = { price: number(data.priceUsd), fdv: number(data.fdv), liquidity: number(data.liquidityUsd), volume: number(data.volume24h), change: data.change24h == null ? 'Unavailable' : `${number(data.change24h, false)}%` };
    for (const [id, value] of Object.entries(values)) document.getElementById(id).textContent = data.status === 'live' ? value : '—';
  }
  async function refreshMarket() {
    try {
      const response = await fetch('/api/market', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (stopped) return;
      updateCoinMarket(data);
      market.replaceChildren();
      if (data.status !== 'live') {
        market.textContent = data.message || 'Market data is temporarily unavailable.';
        return;
      }
      const metrics = [['Price', number(data.priceUsd)], ['24h change', data.change24h == null ? 'Unavailable' : `${number(data.change24h, false)}%`], ['24h volume', number(data.volume24h)], ['Liquidity', number(data.liquidityUsd)]];
      const list = document.createElement('dl');
      for (const [label, value] of metrics) {
        const item = document.createElement('div');
        const name = document.createElement('dt');
        const amount = document.createElement('dd');
        name.textContent = label;
        amount.textContent = value;
        item.append(name, amount);
        list.append(item);
      }
      const updated = document.createElement('small');
      const time = new Date(data.updatedAt);
      updated.textContent = `USD · Updated ${Number.isNaN(time.getTime()) ? 'recently' : time.toLocaleTimeString()} · Market data may be delayed`;
      market.append(list, updated);
    } catch {
      updateCoinMarket({ status: 'unavailable', message: 'Market data could not be reached. Retrying automatically.' });
      if (!stopped) market.textContent = 'Market data could not be reached. Retrying automatically.';
    }
  }
  async function refreshActivity() {
    try {
      const response = await fetch('/api/feed', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (stopped) return;
      activity.replaceChildren();
      const posts = (data.posts || []).slice(0, 10);
      if (!posts.length) activity.textContent = 'Your community story starts here. Share the first photo in the community feed.';
      for (const post of posts) {
        const link = document.createElement('a');
        link.href = '#community-feed';
        const author = String(post.author || 'Community');
        link.textContent = `♡ ${author.slice(0, 4)}…${author.slice(-4)} shared a photo${post.caption ? ` · ${post.caption}` : ''}`;
        activity.append(link);
      }
      activity.classList.toggle('has-posts', posts.length > 0);
    } catch {
      if (!stopped) activity.textContent = 'Community activity is temporarily unavailable. Retrying automatically.';
    }
  }
  refreshMarket();
  refreshActivity();
  document.addEventListener('jcq:feed-changed', () => { if (!stopped) refreshActivity(); });
  const timer = setInterval(() => { if (!document.hidden) { refreshMarket(); refreshActivity(); } }, 30_000);
  window.addEventListener('pagehide', () => { stopped = true; clearInterval(timer); }, { once: true });
}
