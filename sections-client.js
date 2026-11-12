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
    care: ['♡ Care · People first', 'Make someone feel supported.', 'A helpful outcome, not just a hello.', 'Help a newcomer take their first useful step, or follow through on an agreed need. Explain what changed and how you checked it helped.'],
    help: ['✦ Help · Useful work', 'Make the next step easier.', 'A finished task, not a promise to help.', 'Complete an agreed practical task, or teach someone to do it independently. Record the result and how it was checked.'],
    build: ['♛ Build · Lasting value', 'Leave something others can use.', 'A lasting result, not a bigger crowd.', 'Publish a resource another member actually uses, or coordinate a shared project through to a delivered result.'],
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
