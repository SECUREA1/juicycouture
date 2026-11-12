import bs58 from 'bs58';

const PATHS = { care: 'Care', help: 'Help', build: 'Build' };
const STATUS = { pending: 'Awaiting review', approved: 'Spark stamp earned', declined: 'Changes requested' };

// Recognition uses signed messages only. It never requests a transaction or
// assigns a monetary value to a contribution, title, or Spark stamp.
export function initProgram({ getWallet, subscribe } = {}) {
  const $ = id => document.getElementById(id);
  const els = {
    status: $('program-status'), missions: $('program-missions'), wallet: $('program-wallet-state'),
    title: $('program-title-state'), total: $('program-stamp-count'), paths: $('program-path-progress'),
    next: $('program-next'), form: $('program-form'), mission: $('program-mission'),
    evidence: $('program-evidence'), submit: $('program-submit'), claims: $('program-my-claims'),
    reviewPanel: $('program-review-panel'), reviews: $('program-review-list'), refresh: $('program-refresh'),
  };
  const filters = [...document.querySelectorAll('[data-program-path]')];
  let data = null;
  let path = 'all';
  let busy = false;
  let loading = false;
  let queuedLoad = false;
  let destroyed = false;
  let revision = 0;
  let currentAddress = getWallet?.()?.address || null;

  const node = (tag, value, className) => {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = value;
    if (className) element.className = className;
    return element;
  };
  const status = (message, kind = 'pending') => {
    els.status.textContent = message;
    els.status.className = `status ${kind}`;
  };
  const walletNow = () => getWallet?.() || null;
  const progressNow = () => data?.progress && data.progress.wallet === walletNow()?.address ? data.progress : null;
  const mine = () => (data?.claims || []).filter(claim => claim.wallet === walletNow()?.address);
  const canReview = wallet => Boolean(wallet && data?.program?.reviewReady && data.program.reviewers?.includes(wallet.address));
  const missionName = id => data?.missions?.find(mission => mission.id === id)?.title || id;
  function sameWallet(wallet, expectedRevision) {
    if (destroyed || revision !== expectedRevision || walletNow()?.address !== wallet.address)
      throw new Error('Your wallet changed. Review the contribution again with your current wallet.');
  }
  async function request(url, body) {
    const response = await fetch(url, {
      credentials: 'same-origin', cache: 'no-store',
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error('The recognition service returned an unreadable response. Please try again.'); }
    if (!response.ok) throw new Error(result.error || 'The recognition request could not be completed.');
    return result;
  }
  function controls() {
    const wallet = walletNow();
    const canSign = typeof wallet?.signMessage === 'function';
    const ready = Boolean(data && wallet && canSign && els.mission.value);
    els.submit.disabled = loading || busy || !ready;
    els.refresh.disabled = loading || busy;
    els.mission.disabled = loading || busy || !wallet || !canSign;
    els.evidence.disabled = loading || busy || !wallet || !canSign;
    for (const button of els.reviews.querySelectorAll('button')) button.disabled = loading || busy;
    for (const input of els.reviews.querySelectorAll('textarea')) input.disabled = loading || busy;
  }
  function renderProgress() {
    const wallet = walletNow();
    const progress = progressNow();
    els.wallet.textContent = !wallet ? 'Connect a Solana wallet to keep your own Juicy Journey.'
      : typeof wallet.signMessage !== 'function' ? 'Your wallet can view recognition. Submitting or reviewing needs message signing.'
      : `${wallet.address.slice(0, 5)}…${wallet.address.slice(-5)} · Message signatures only; no funds move.`;
    if (data && !data.program.reviewReady)
      els.wallet.append(node('small', ' No authorized reviewers are configured yet. You can submit a contribution; it stays pending until an authorized reviewer is available.'));
    els.title.textContent = progress ? progress.milestone : wallet ? 'Loading your journey…' : 'Your journey';
    els.total.textContent = progress ? String(progress.total) : '—';
    els.paths.replaceChildren();
    if (progress) {
      for (const [id, label] of Object.entries(PATHS)) {
        const item = node('div', undefined, 'program-path-stat');
        item.append(node('strong', String(progress.paths?.[id] || 0)), node('span', label));
        els.paths.append(item);
      }
      if (!progress.nextMilestone) els.next.textContent = 'Crown recognition earned. Keep using your experience to support others; titles are recognition, not payout or access rights.';
      else {
        const next = progress.nextMilestone;
        const needed = Number(next.missionsNeeded) || 0;
        const breadth = Array.isArray(next.pathsNeeded) ? next.pathsNeeded.length : Number(next.pathsNeeded) || 0;
        els.next.textContent = `Next: ${next.name}. ${needed} more distinct ${needed === 1 ? 'mission' : 'missions'}${breadth ? ` and ${breadth} more ${breadth === 1 ? 'path' : 'paths'}` : ''} needed. Each approved mission earns one permanent Spark stamp.`;
      }
    } else els.next.textContent = wallet ? 'Reading your verified mission record…' : 'Connect your wallet to view earned stamps and your next recognition milestone.';
  }
  function renderMissions() {
    const progress = progressNow();
    const ownClaims = mine();
    const previous = els.mission.value;
    els.mission.replaceChildren();
    els.missions.replaceChildren();
    for (const mission of data?.missions || []) {
      const earned = progress?.approvedMissionIds?.includes(mission.id);
      const claim = ownClaims.find(item => item.missionId === mission.id);
      if (!earned && claim?.status !== 'pending') {
        const option = node('option', `${mission.title} · ${PATHS[mission.path] || mission.path}`);
        option.value = mission.id;
        els.mission.append(option);
      }
      if (path !== 'all' && path !== mission.path) continue;
      const card = node('article', undefined, 'program-mission program-mission-card');
      card.dataset.missionId = mission.id;
      card.append(node('span', PATHS[mission.path] || mission.path, 'program-path'), node('h3', mission.title));
      card.append(node('p', mission.criteria, 'program-criteria'));
      if (mission.example) card.append(node('p', `Example: ${mission.example}`, 'program-example'));
      card.append(node('span', earned ? '✓ Spark stamp earned' : claim ? STATUS[claim.status] || 'Awaiting review' : 'One verified outcome · one Spark stamp', 'program-mission-state'));
      els.missions.append(card);
    }
    if ([...els.mission.options].some(option => option.value === previous)) els.mission.value = previous;
    if (data && !els.mission.options.length) {
      const option = node('option', 'All missions are earned or awaiting review');
      option.value = '';
      els.mission.append(option);
    }
  }
  function claimCard(claim) {
    const card = node('article', undefined, 'program-claim');
    card.append(node('h4', missionName(claim.missionId)), node('span', STATUS[claim.status] || claim.status, 'program-claim-status'));
    card.append(node('p', claim.evidence, 'program-evidence'));
    if (claim.reviewNote) card.append(node('p', `Reviewer note: ${claim.reviewNote}`, 'program-review-note'));
    return card;
  }
  function renderClaims() {
    els.claims.replaceChildren();
    const claims = mine();
    if (!walletNow()) els.claims.append(node('p', 'Connect your wallet to view your recent contribution submissions.'));
    else if (!claims.length) els.claims.append(node('p', 'No recent submissions for this wallet. Choose a mission and describe the outcome you delivered.'));
    for (const claim of claims) els.claims.append(claimCard(claim));
    els.reviewPanel.hidden = !canReview(walletNow());
    els.reviews.replaceChildren();
    if (els.reviewPanel.hidden) return;
    const pending = (data?.claims || []).filter(claim => claim.status === 'pending' && claim.wallet !== walletNow()?.address);
    if (!pending.length) els.reviews.append(node('p', 'No recent contributions are waiting for your review. You cannot review your own submissions.'));
    for (const claim of pending) {
      const card = claimCard(claim);
      card.append(node('p', `Submitted by ${claim.wallet}`, 'program-claim-wallet'));
      const form = node('form', undefined, 'program-review-form');
      const label = node('label', 'Review note · explain how the mission criteria were met or what needs work');
      const note = node('textarea');
      note.minLength = 10; note.maxLength = 500; note.required = true; note.rows = 3;
      note.name = 'note';
      label.append(note);
      const approve = node('button', 'Approve contribution', 'small-button');
      approve.type = 'submit'; approve.value = 'approve';
      const decline = node('button', 'Request changes', 'small-button');
      decline.type = 'submit'; decline.value = 'decline';
      form.append(label, approve, decline);
      form.addEventListener('submit', event => {
        event.preventDefault();
        const decision = event.submitter?.value;
        if (!['approve', 'decline'].includes(decision)) return;
        const reviewNote = note.value.trim();
        if (reviewNote.length < 10 || reviewNote.length > 500) { status('Add a review note between 10 and 500 characters.', 'error'); return; }
        void manage('review', { claimId: claim.id, decision, note: reviewNote }, decision === 'approve' ? 'Contribution approved. One Spark stamp has been recorded.' : 'Changes requested. The member can improve the outcome note and resubmit.');
      });
      card.append(form);
      els.reviews.append(card);
    }
  }
  function render() {
    renderProgress();
    renderMissions();
    renderClaims();
    for (const filter of filters) filter.setAttribute('aria-pressed', String(filter.dataset.programPath === path));
    controls();
    document.dispatchEvent(new CustomEvent('jcq:program', { detail: {
      total: progressNow()?.total ?? null, milestone: progressNow()?.milestone ?? null,
      reviewReady: Boolean(data?.program?.reviewReady),
    } }));
  }
  async function load(preserveStatus = false) {
    if (destroyed) return;
    if (loading || busy) { queuedLoad = true; return; }
    const expectedAddress = walletNow()?.address || null;
    loading = true; controls();
    if (!preserveStatus) status('Loading Juicy Journey missions and verified recognition…');
    try {
      const result = await request(`/api/program${expectedAddress ? `?wallet=${encodeURIComponent(expectedAddress)}` : ''}`);
      if (destroyed) return;
      if (!Array.isArray(result.missions) || !Array.isArray(result.claims) || !result.program)
        throw new Error('The recognition record could not be read. Please refresh.');
      if (expectedAddress !== (walletNow()?.address || null)) { queuedLoad = true; return; }
      data = result;
      if (!preserveStatus) status(result.program.reviewReady ? 'Mission catalog and recognition record are up to date.' : 'Missions are available. Reviews are pending an authorized program reviewer.');
      render();
    } catch (error) { if (!destroyed) status(error.message || 'The recognition service is unavailable. Try refreshing.', 'error'); }
    finally {
      loading = false;
      if (!destroyed) {
        controls();
        if (queuedLoad) { queuedLoad = false; void load(preserveStatus); }
      }
    }
  }
  async function manage(action, payload, success) {
    if (destroyed || busy || loading) return;
    const wallet = walletNow();
    if (!wallet || typeof wallet.signMessage !== 'function') { status('Connect a wallet that supports message signing.', 'error'); return; }
    if (action === 'review' && !canReview(wallet)) { status('Only an authorized reviewer can review contributions.', 'error'); return; }
    const expectedRevision = revision;
    busy = true; controls();
    let saved = false;
    try {
      sameWallet(wallet, expectedRevision);
      const challenge = await request('/api/program/challenge', { wallet: wallet.address, action, payload });
      sameWallet(wallet, expectedRevision);
      const expiry = typeof challenge.expiresAt === 'number' ? challenge.expiresAt : Date.parse(challenge.expiresAt);
      if (typeof challenge.challengeId !== 'string' || typeof challenge.message !== 'string'
        || !challenge.message.includes(wallet.address) || !challenge.message.includes(location.host)
        || !Number.isFinite(expiry) || expiry <= Date.now())
        throw new Error('The contribution signature request could not be verified. Please retry.');
      status('Review the contribution message in your wallet. Signing records this action; it does not transfer coins.');
      // signMessage already owns the shared wallet UI lock. withWalletLock is
      // reserved for transactions; wrapping signMessage in it would deadlock.
      const signature = await wallet.signMessage(new TextEncoder().encode(challenge.message));
      sameWallet(wallet, expectedRevision);
      if (!(signature instanceof Uint8Array) || signature.length !== 64)
        throw new Error('Your wallet did not return a valid message signature.');
      if (expiry <= Date.now()) throw new Error('The contribution request expired. Please retry.');
      await request('/api/program/actions', { wallet: wallet.address, challengeId: challenge.challengeId, signature: bs58.encode(signature) });
      sameWallet(wallet, expectedRevision);
      saved = true;
      if (action === 'submit') els.evidence.value = '';
      status(success, 'success');
    } catch (error) {
      if (!destroyed) status(error.code === 4001 ? 'Wallet signature cancelled. No recognition action was saved.' : error.message || 'The recognition action could not be completed.', 'error');
    } finally {
      busy = false;
      if (!destroyed) {
        controls();
        const reload = saved || queuedLoad;
        queuedLoad = false;
        if (reload) void load(saved);
      }
    }
  }
  function onSubmit(event) {
    event.preventDefault();
    const evidence = els.evidence.value.trim();
    const missionId = els.mission.value;
    if (!data?.missions.some(mission => mission.id === missionId)) { status('Choose an available mission first.', 'error'); return; }
    if (evidence.length < 30 || evidence.length > 1000) { status('Describe the delivered outcome in 30–1,000 characters. Keep private details out of this public note.', 'error'); return; }
    void manage('submit', { missionId, evidence }, 'Contribution submitted for review. A Spark stamp is recorded only after approval.');
  }
  function onWallet() {
    const address = walletNow()?.address || null;
    if (address !== currentAddress) {
      currentAddress = address;
      revision++;
      render();
      void load();
    } else controls();
  }
  function onFilter(event) { path = event.currentTarget.dataset.programPath; render(); }
  const onRefresh = () => { void load(); };
  els.form.addEventListener('submit', onSubmit);
  els.refresh.addEventListener('click', onRefresh);
  for (const filter of filters) filter.addEventListener('click', onFilter);
  const unsubscribe = subscribe?.(onWallet);
  render();
  void load();
  return {
    refresh: () => load(),
    destroy() {
      destroyed = true; revision++;
      els.form.removeEventListener('submit', onSubmit);
      els.refresh.removeEventListener('click', onRefresh);
      for (const filter of filters) filter.removeEventListener('click', onFilter);
      if (typeof unsubscribe === 'function') unsubscribe();
    },
  };
}
