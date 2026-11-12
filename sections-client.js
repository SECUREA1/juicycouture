export function initSections() {
  const buttons = [...document.querySelectorAll('[data-panel]')];
  const panels = [...document.querySelectorAll('[data-app-panel]')];
  const aliases = { home: 'coin', story: 'coin', token: 'coin', faq: 'coin', 'how-it-works': 'coin', rewards: 'rewards', 'live-room': 'live', 'community-feed': 'feed', wallet: 'tips', 'ticker-title': 'market' };
  function show(key, scroll = false) {
    if (!panels.some(panel => panel.dataset.appPanel === key)) key = 'coin';
    for (const panel of panels) panel.hidden = panel.dataset.appPanel !== key;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.panel === key));
    const panel = document.getElementById(`panel-${key}`);
    panel.classList.remove('panel-entering');
    requestAnimationFrame(() => { if (!panel.hidden) panel.classList.add('panel-entering'); });
    document.dispatchEvent(new CustomEvent('jcq:section', { detail: { key } }));
    if (scroll) {
      let hash = location.hash.slice(1);
      try { hash = decodeURIComponent(hash); } catch {}
      const target = document.getElementById(hash);
      (target && !target.closest('[hidden]') ? target : document.getElementById(`panel-${key}`)).scrollIntoView({ block: 'start' });
    }
  }
  function fromLocation(scroll = false) {
    const hash = location.hash.slice(1);
    show(aliases[hash] || (hash.startsWith('panel-') ? hash.slice(6) : new URLSearchParams(location.search).has('room') ? 'live' : 'coin'), scroll);
  }
  for (const button of buttons) button.addEventListener('click', () => {
    const key = button.dataset.panel;
    history.pushState(null, '', `#panel-${key}`);
    show(key, true);
  });
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link || link.getAttribute('href') === '#') return;
    const hash = link.getAttribute('href').slice(1);
    const key = aliases[hash] || (hash.startsWith('panel-') ? hash.slice(6) : null);
    if (!key) return;
    event.preventDefault();
    history.pushState(null, '', `#${hash}`);
    show(key, true);
  });
  window.addEventListener('hashchange', () => fromLocation(true));
  window.addEventListener('popstate', () => fromLocation());
  const rewards = {
    breakfast: ['🥐 Sweet Start · activity badge', 'Breakfast Bloom', '$2 CAD value in coin', 'Verified breakfast attendance at an approved community gathering. Say hello, share a meal, and be part of the moment.'],
    helping: ['♡ Helping Heart · participation badge', 'Helping Hands', 'Up to $5 CAD value in coin', 'Useful event help, welcoming a new face, and lending a hand at an approved gathering.'],
    vibes: ['✦ Good Vibes · participation badge', 'Good Vibes', 'Up to $5 CAD value in coin', 'Respectful participation, encouragement, and positive, constructive engagement.'],
    community: ['♛ Crown Builder · community badge', 'Community Builder', 'Up to $10 CAD value in coin', 'Organizing activities, connecting people, and helping the real-life community grow.'],
  };
  for (const button of document.querySelectorAll('[data-reward]')) button.addEventListener('click', () => {
    const values = rewards[button.dataset.reward];
    ['badge', 'name', 'value', 'description'].forEach((id, index) => { document.getElementById(`preview-${id}`).textContent = values[index]; });
    for (const choice of document.querySelectorAll('[data-reward]')) choice.setAttribute('aria-pressed', String(choice === button));
  });
  fromLocation();
  const motion = document.querySelector('#toggle-motion');
  motion.addEventListener('click', () => {
    const paused = document.body.classList.toggle('motion-paused');
    motion.setAttribute('aria-pressed', String(paused));
    motion.textContent = paused ? 'Resume motion' : 'Pause motion';
  });
}
