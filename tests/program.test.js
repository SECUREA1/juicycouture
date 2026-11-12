import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createProgramService } from '../program.js';

const evidence = 'Completed the agreed useful outcome, checked it with the member, and confirmed they could continue independently.';
const reviewNote = 'I checked the outcome against the published mission criteria.';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jcq-program-'));
  const reviewer = Keypair.generate();
  const otherReviewer = Keypair.generate();
  const member = Keypair.generate();
  const state = { time: Date.now() };
  const env = { MEDIA_DATA_DIR: directory, REWARD_HOST_WALLETS: `${reviewer.publicKey.toBase58()},${otherReviewer.publicKey.toBase58()}`, TOKEN_MINT: '', ...options.env };
  let service = createProgramService({ env, now: () => state.time });
  const server = createServer(async (req, res) => {
    const handled = await service.handle(req, res, new URL(req.url, 'http://localhost'));
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    service.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function post(path, body, headers = {}) {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  }
  async function get(wallet = null) {
    const response = await fetch(`${base}/api/program${wallet ? `?wallet=${wallet.publicKey.toBase58()}` : ''}`);
    assert.equal(response.status, 200);
    return response.json();
  }
  const sign = (challenge, signer) => ({ challengeId: challenge.challengeId, wallet: signer.publicKey.toBase58(), signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), signer.secretKey)) });
  async function challenge(action, payload, signer = member) {
    const result = await post('/api/program/challenge', { wallet: signer.publicKey.toBase58(), action, payload });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value;
  }
  async function act(action, payload, signer = member) {
    const item = await challenge(action, payload, signer);
    const result = await post('/api/program/actions', sign(item, signer));
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value;
  }
  const submit = (missionId = 'welcome', signer = member, extra = {}) => act('submit', { missionId, evidence, ...extra }, signer);
  const review = (claimId, signer = reviewer, decision = 'approve', note = reviewNote) => act('review', { claimId, decision, note }, signer);
  return { get service() { return service; }, env, state, reviewer, otherReviewer, member, base, post, get, sign, challenge, act, submit, review,
    reopen() { service.close(); service = createProgramService({ env, now: () => state.time }); },
  };
}

test('Juicy Journey recognizes outcomes without a mint, monetary amounts, or attendance', async t => {
  const f = await fixture(t);
  const page = await f.get(f.member);
  assert.equal(page.program.name, 'Juicy Journey');
  assert.equal(page.program.reviewReady, true);
  assert.equal(page.missions.length, 6);
  assert.deepEqual([...new Set(page.missions.map(item => item.path))].sort(), ['build', 'care', 'help']);
  assert.ok(page.missions.every(item => item.criteria.length > 30 && item.example.length > 30));
  assert.equal(page.progress.milestone, 'New chapter');
  assert.equal(page.progress.total, 0);
  assert.equal(JSON.stringify(page).includes('cadAmount'), false);
  const pending = await f.submit();
  assert.equal(pending.claim.status, 'pending');
  assert.equal(pending.progress.total, 0);
  const approved = await f.review(pending.claim.id);
  assert.equal(approved.claim.status, 'approved');
  assert.equal(approved.progress.total, 1);
  assert.equal(approved.progress.milestone, 'Spark');
  assert.deepEqual(approved.progress.paths, { care: 1, help: 0, build: 0 });
});

test('submissions require published missions and useful completion notes', async t => {
  const f = await fixture(t);
  for (const payload of [{ missionId: 'attendance', evidence }, { missionId: 'welcome', evidence: 'I joined.' }, { missionId: 'welcome', evidence: 'x'.repeat(1001) }]) {
    const result = await f.post('/api/program/challenge', { wallet: f.member.publicKey.toBase58(), action: 'submit', payload });
    assert.equal(result.status, 400);
  }
  assert.equal((await f.get()).claims.length, 0);
});

test('no configured reviewer keeps claims pending and reports the prerequisite', async t => {
  const f = await fixture(t, { env: { REWARD_HOST_WALLETS: '' } });
  assert.equal(f.service.config().reviewReady, false);
  assert.match(f.service.config().message, /approval waits/);
  const pending = await f.submit();
  const result = await f.post('/api/program/challenge', { wallet: f.reviewer.publicKey.toBase58(), action: 'review', payload: { claimId: pending.claim.id, decision: 'approve', note: reviewNote } });
  assert.equal(result.status, 403);
  assert.equal((await f.get(f.member)).progress.total, 0);
});

test('reviewers must be authorized and cannot award their own contribution', async t => {
  const f = await fixture(t);
  const pending = await f.submit();
  const outsider = Keypair.generate();
  const denied = await f.post('/api/program/challenge', { wallet: outsider.publicKey.toBase58(), action: 'review', payload: { claimId: pending.claim.id, decision: 'approve', note: reviewNote } });
  assert.equal(denied.status, 403);
  const own = await f.submit('lend-a-hand', f.reviewer);
  const self = await f.post('/api/program/challenge', { wallet: f.reviewer.publicKey.toBase58(), action: 'review', payload: { claimId: own.claim.id, decision: 'approve', note: reviewNote } });
  assert.equal(self.status, 403);
  const approved = await f.review(own.claim.id, f.otherReviewer);
  assert.equal(approved.progress.total, 1);
});

test('one mission gives one permanent stamp; repeated approval is idempotent', async t => {
  const f = await fixture(t);
  const pending = await f.submit();
  let duplicate = await f.post('/api/program/challenge', { wallet: f.member.publicKey.toBase58(), action: 'submit', payload: { missionId: 'welcome', evidence } });
  assert.equal(duplicate.status, 409);
  const first = await f.review(pending.claim.id);
  const again = await f.review(pending.claim.id, f.otherReviewer, 'approve', 'A second independent check still confirms this result.');
  assert.equal(again.progress.total, 1);
  assert.equal(again.claim.reviewer, first.claim.reviewer);
  assert.equal(again.claim.reviewNote, first.claim.reviewNote);
  duplicate = await f.post('/api/program/challenge', { wallet: f.member.publicKey.toBase58(), action: 'submit', payload: { missionId: 'welcome', evidence } });
  assert.equal(duplicate.status, 409);
  const decline = await f.post('/api/program/challenge', { wallet: f.reviewer.publicKey.toBase58(), action: 'review', payload: { claimId: pending.claim.id, decision: 'decline', note: reviewNote } });
  assert.equal(decline.status, 409);
});

test('declined evidence can be revised without creating duplicates or reusing old approvals', async t => {
  const f = await fixture(t);
  const pending = await f.submit();
  const stale = await f.challenge('review', { claimId: pending.claim.id, decision: 'approve', note: reviewNote }, f.otherReviewer);
  const declined = await f.review(pending.claim.id, f.reviewer, 'decline', 'Please describe the confirmed useful result, rather than the activity alone.');
  assert.equal(declined.progress.total, 0);
  const revised = await f.submit('welcome', f.member, { evidence: 'Revised evidence: the newcomer completed the agreed first task independently and confirmed the support was useful.' });
  assert.equal(revised.claim.id, pending.claim.id);
  assert.equal(revised.claim.status, 'pending');
  assert.equal(revised.claim.reviewNote, null);
  const staleResult = await f.post('/api/program/actions', f.sign(stale, f.otherReviewer));
  assert.equal(staleResult.status, 409);
  assert.equal((await f.get(f.member)).progress.total, 0);
  const approved = await f.review(revised.claim.id);
  assert.equal(approved.progress.total, 1);
  assert.equal((await f.get()).claims.length, 1);
});

test('milestones require distinct outcomes and breadth across Care, Help, and Build', async t => {
  const f = await fixture(t);
  const order = ['welcome', 'follow-through', 'lend-a-hand', 'pass-it-on', 'shared-toolkit', 'bring-together'];
  for (let index = 0; index < order.length; index++) {
    const pending = await f.submit(order[index]);
    const approved = await f.review(pending.claim.id);
    assert.equal(approved.progress.total, index + 1);
    assert.equal(approved.progress.milestone, index < 2 ? 'Spark' : index < 5 ? 'Charm' : 'Crown');
    if (index === 1) assert.deepEqual(approved.progress.nextMilestone, { name: 'Charm', missionsNeeded: 1, pathsNeeded: 1 });
    if (index === 5) {
      assert.deepEqual(approved.progress.paths, { care: 2, help: 2, build: 2 });
      assert.equal(approved.progress.nextMilestone, null);
    }
  }
});

test('claims and earned titles survive restart; pending challenges do not', async t => {
  const f = await fixture(t);
  const pending = await f.submit();
  await f.review(pending.claim.id);
  const unfinished = await f.challenge('submit', { missionId: 'shared-toolkit', evidence });
  f.reopen();
  const page = await f.get(f.member);
  assert.equal(page.progress.total, 1);
  assert.equal(page.progress.milestone, 'Spark');
  assert.equal(page.claims[0].status, 'approved');
  assert.equal((await f.post('/api/program/actions', f.sign(unfinished, f.member))).status, 401);
});

test('signatures expire, bind the wallet and signed content, and cannot be replayed', async t => {
  const f = await fixture(t);
  let challenge = await f.challenge('submit', { missionId: 'welcome', evidence });
  let request = f.sign(challenge, f.member);
  assert.match(challenge.message, /Domain: 127\.0\.0\.1:/);
  assert.match(challenge.message, /does not transfer tokens/);
  assert.equal((await f.post('/api/program/actions', request)).status, 200);
  assert.equal((await f.post('/api/program/actions', request)).status, 401);
  challenge = await f.challenge('submit', { missionId: 'pass-it-on', evidence });
  request = f.sign(challenge, f.member);
  f.state.time += 120_001;
  assert.equal((await f.post('/api/program/actions', request)).status, 401);
  challenge = await f.challenge('submit', { missionId: 'pass-it-on', evidence });
  request = f.sign(challenge, f.reviewer);
  assert.equal((await f.post('/api/program/actions', request)).status, 401);
  challenge = await f.challenge('submit', { missionId: 'pass-it-on', evidence });
  request = f.sign({ ...challenge, message: `${challenge.message} altered` }, f.member);
  assert.equal((await f.post('/api/program/actions', request)).status, 401);
});

test('cross-origin actions and arbitrary invalid signatures are rejected', async t => {
  const f = await fixture(t);
  const payload = { wallet: f.member.publicKey.toBase58(), action: 'submit', payload: { missionId: 'welcome', evidence } };
  assert.equal((await f.post('/api/program/challenge', payload, { origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await f.post('/api/program/challenge', payload, { origin: 'null' })).status, 403);
  const challenge = await f.challenge('submit', payload.payload);
  const request = { wallet: f.member.publicKey.toBase58(), challengeId: challenge.challengeId, signature: 'not a signature' };
  assert.equal((await f.post('/api/program/actions', request)).status, 401);
  assert.equal((await f.get()).claims.length, 0);
});

test('concurrent signed submissions cannot duplicate a mission and challenge storage is bounded', async t => {
  const f = await fixture(t);
  const payload = { missionId: 'welcome', evidence };
  const first = await f.challenge('submit', payload);
  const second = await f.challenge('submit', payload);
  assert.equal((await f.post('/api/program/actions', f.sign(first, f.member))).status, 200);
  assert.equal((await f.post('/api/program/actions', f.sign(second, f.member))).status, 409);
  for (let index = 0; index < 10; index++) await f.challenge('submit', { missionId: 'pass-it-on', evidence });
  const full = await f.post('/api/program/challenge', { wallet: f.member.publicKey.toBase58(), action: 'submit', payload: { missionId: 'pass-it-on', evidence } });
  assert.equal(full.status, 429);
  f.state.time += 120_001;
  await f.challenge('submit', { missionId: 'pass-it-on', evidence });
  assert.equal((await f.get()).claims.length, 1);
});
