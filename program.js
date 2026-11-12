import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const CHALLENGE_TTL = 120_000;
const MISSIONS = [
  { id: 'welcome', title: 'Make room for someone', path: 'care', criteria: 'Help a newcomer complete a useful first step and confirm they can continue comfortably.', example: 'Helped a new member find the right project, complete their first task, and identify who to ask for support.' },
  { id: 'follow-through', title: 'Follow through with care', path: 'care', criteria: 'Agree on a real support need, take practical action, and check back to confirm the need was resolved.', example: 'Arranged the agreed support, checked back afterward, and confirmed that the member could move forward.' },
  { id: 'lend-a-hand', title: 'Lend a useful hand', path: 'help', criteria: 'Complete an agreed practical task and describe the useful result the community received.', example: 'Finished the agreed preparation checklist and handed over the materials ready for the community project.' },
  { id: 'pass-it-on', title: 'Pass the know-how on', path: 'help', criteria: 'Guide another member through a useful task, then confirm they can complete it independently.', example: 'Walked a member through the task, then watched them complete the next one without my help.' },
  { id: 'shared-toolkit', title: 'Leave a shared toolkit', path: 'build', criteria: 'Publish a reusable guide or resource and confirm another member successfully used it.', example: 'Published a clear reusable checklist, incorporated feedback, and confirmed another member used it for their project.' },
  { id: 'bring-together', title: 'Bring a project together', path: 'build', criteria: 'Coordinate a shared project with clear roles and confirm a delivered outcome the community can use.', example: 'Coordinated responsibilities, resolved the handover gaps, and confirmed the finished project was delivered and usable.' },
];
const MISSION_MAP = new Map(MISSIONS.map(mission => [mission.id, mission]));

class ProgramError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
function walletKey(value) {
  try {
    if (typeof value !== 'string' || value.length > 44) throw new Error();
    const key = new PublicKey(value);
    if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes())) throw new Error();
    return key;
  } catch { throw new ProgramError(400, 'Use a valid Solana wallet address.'); }
}
function domain(req) {
  try {
    const raw = req.headers.host;
    if (typeof raw !== 'string' || raw.length > 255 || /[\s/@?#\\]/.test(raw)) throw new Error();
    const parsed = new URL(`http://${raw}`);
    if (!parsed.hostname || parsed.username || parsed.password) throw new Error();
    return parsed.host;
  } catch { throw new ProgramError(400, 'Open Juicy Journey at this app’s address.'); }
}
function sameOrigin(req) {
  const host = domain(req);
  let origin;
  try { origin = new URL(req.headers.origin); } catch {}
  if (req.headers['sec-fetch-site'] === 'cross-site' || !origin || !['http:', 'https:'].includes(origin.protocol) || origin.host !== host) {
    throw new ProgramError(403, 'Open Juicy Journey on this app to submit or review a contribution.');
  }
  return host;
}
async function readJson(req) {
  const maximum = 8192;
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    req.resume();
    throw new ProgramError(413, 'Keep program requests smaller than 8 KiB.');
  }
  const raw = await new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    const timeout = setTimeout(() => {
      failed = true;
      chunks.length = 0;
      reject(new ProgramError(408, 'The contribution request timed out. Please try again.'));
    }, 10_000);
    timeout.unref?.();
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > maximum) {
        failed = true;
        clearTimeout(timeout);
        chunks.length = 0;
        reject(new ProgramError(413, 'Keep program requests smaller than 8 KiB.'));
      } else chunks.push(chunk);
    });
    req.on('end', () => { clearTimeout(timeout); if (!failed) resolveBody(Buffer.concat(chunks)); });
    req.on('error', error => { clearTimeout(timeout); if (!failed) reject(error); });
    req.on('aborted', () => { clearTimeout(timeout); if (!failed) reject(new ProgramError(400, 'The contribution request was interrupted.')); });
  });
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ProgramError(400, 'Use a valid Juicy Journey request.'); }
}
function note(value, minimum, maximum, label) {
  if (typeof value !== 'string') throw new ProgramError(400, `Add a ${label}.`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) {
    throw new ProgramError(400, `The ${label} must contain ${minimum}–${maximum} characters of plain text.`);
  }
  return result;
}

// This nonmonetary ledger is deliberately independent of reward_drops and token
// transactions. A stamp records a verified outcome, never a balance or a payout.
export function createProgramService({ env = process.env, now = Date.now } = {}) {
  const directory = resolve(env.MEDIA_DATA_DIR || '.data/community');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(directory, 'program.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS program_claims (
      id TEXT PRIMARY KEY, wallet TEXT NOT NULL, mission_id TEXT NOT NULL, evidence TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','approved','declined')), reviewer TEXT, review_note TEXT,
      created_at INTEGER NOT NULL, reviewed_at INTEGER, revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE(wallet,mission_id)
    );
    CREATE INDEX IF NOT EXISTS program_claims_wallet ON program_claims(wallet,status);
    CREATE INDEX IF NOT EXISTS program_claims_recent ON program_claims(created_at);`);
  let reviewers = [];
  let configurationError = '';
  try {
    reviewers = [...new Set(String(env.REWARD_HOST_WALLETS || '').split(',').map(item => item.trim()).filter(Boolean))];
    reviewers.forEach(walletKey);
  } catch {
    reviewers = [];
    configurationError = 'Program reviewer wallets are invalid. Ask the app owner to check REWARD_HOST_WALLETS.';
  }
  const challenges = new Map();
  const rates = new Map();
  function config() {
    return {
      name: 'Juicy Journey', reviewers: [...reviewers], reviewReady: reviewers.length > 0,
      stampName: 'Spark stamp',
      message: configurationError || (reviewers.length ? 'An authorized community reviewer verifies each outcome. Stamps and titles have no cash value or automatic token entitlement.' : 'Contributions can be submitted, but approval waits for an authorized community reviewer. Stamps and titles have no cash value or automatic token entitlement.'),
    };
  }
  function prune() {
    const time = now();
    for (const [id, challenge] of challenges) if (challenge.expiresAt <= time) challenges.delete(id);
    for (const [ip, rate] of rates) if (rate.expiresAt <= time) rates.delete(ip);
  }
  function rate(req) {
    prune();
    const ip = req.socket.remoteAddress || 'unknown';
    let entry = rates.get(ip);
    if (!entry) {
      if (rates.size >= 10_000) throw new ProgramError(503, 'Juicy Journey is busy. Please try again shortly.');
      rates.set(ip, entry = { count: 0, expiresAt: now() + 60_000 });
    }
    if (++entry.count > 120) throw new ProgramError(429, 'Too many program requests. Please wait a minute.');
  }
  const find = id => typeof id === 'string' ? db.prepare('SELECT * FROM program_claims WHERE id=?').get(id) : null;
  const forMission = (wallet, mission) => db.prepare('SELECT * FROM program_claims WHERE wallet=? AND mission_id=?').get(wallet, mission);
  const publicClaim = claim => ({
    id: claim.id, wallet: claim.wallet, missionId: claim.mission_id, evidence: claim.evidence, status: claim.status,
    reviewer: claim.reviewer || null, reviewNote: claim.review_note || null,
    createdAt: new Date(claim.created_at).toISOString(), reviewedAt: claim.reviewed_at === null ? null : new Date(claim.reviewed_at).toISOString(),
  });
  function progress(wallet) {
    const approvedMissionIds = db.prepare("SELECT mission_id FROM program_claims WHERE wallet=? AND status='approved' ORDER BY mission_id").all(wallet).map(item => item.mission_id);
    const paths = { care: 0, help: 0, build: 0 };
    for (const id of approvedMissionIds) {
      const mission = MISSION_MAP.get(id);
      if (mission) paths[mission.path]++;
    }
    const total = approvedMissionIds.length;
    const breadth = Object.values(paths).filter(Boolean).length;
    let milestone = 'New chapter';
    if (total >= 6 && breadth >= 3) milestone = 'Crown';
    else if (total >= 3 && breadth >= 2) milestone = 'Charm';
    else if (total >= 1) milestone = 'Spark';
    const next = milestone === 'New chapter' ? { name: 'Spark', count: 1, breadth: 1 } : milestone === 'Spark' ? { name: 'Charm', count: 3, breadth: 2 } : milestone === 'Charm' ? { name: 'Crown', count: 6, breadth: 3 } : null;
    return { wallet, total, paths, milestone, approvedMissionIds, nextMilestone: next ? { name: next.name, missionsNeeded: Math.max(0, next.count - total), pathsNeeded: Math.max(0, next.breadth - breadth) } : null };
  }
  function normalize(action, payload, wallet) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ProgramError(400, 'Use a valid contribution action.');
    if (action === 'submit') {
      const missionId = payload.missionId;
      if (!MISSION_MAP.has(missionId)) throw new ProgramError(400, 'Choose a published Juicy Journey mission.');
      const evidence = note(payload.evidence, 30, 1000, 'completion note');
      const previous = forMission(wallet, missionId);
      if (previous && previous.status !== 'declined') throw new ProgramError(409, previous.status === 'approved' ? 'This mission already earned its permanent Spark stamp.' : 'This mission is already waiting for review.');
      return { missionId, evidence, previousId: previous?.id || null, revision: previous?.revision || 0 };
    }
    if (action !== 'review') throw new ProgramError(400, 'Choose a valid contribution action.');
    if (!reviewers.includes(wallet)) throw new ProgramError(403, 'Only authorized community reviewers can verify contributions.');
    const claim = find(payload.claimId);
    if (!claim) throw new ProgramError(404, 'This contribution was not found.');
    if (claim.wallet === wallet) throw new ProgramError(403, 'A different authorized reviewer must verify your contribution.');
    if (!['approve', 'decline'].includes(payload.decision)) throw new ProgramError(400, 'Choose approve or decline for this contribution.');
    if (claim.status === 'approved' && payload.decision !== 'approve') throw new ProgramError(409, 'An earned permanent stamp cannot be declined.');
    if (claim.status === 'declined' && payload.decision === 'approve') throw new ProgramError(409, 'Ask the member to revise and resubmit their completion note before approval.');
    return { claimId: claim.id, decision: payload.decision, note: note(payload.note, 10, 500, 'review note'), revision: claim.revision };
  }
  function challenge(input, host) {
    const wallet = walletKey(input.wallet).toBase58();
    const payload = normalize(input.action, input.payload, wallet);
    prune();
    if (challenges.size >= 500 || [...challenges.values()].filter(item => item.wallet === wallet).length >= 10) throw new ProgramError(429, 'Too many contribution signatures are pending. Wait for them to expire, then try again.');
    const expiresAt = now() + CHALLENGE_TTL;
    const challengeId = randomUUID();
    const reviewedClaim = input.action === 'review' ? find(payload.claimId) : null;
    const summary = input.action === 'submit'
      ? `Mission: ${MISSION_MAP.get(payload.missionId).title}\nCompletion note (public): ${payload.evidence}`
      : `Contribution: ${payload.claimId}\nMember wallet: ${reviewedClaim.wallet}\nMission: ${MISSION_MAP.get(reviewedClaim.mission_id).title}\nCompletion note (public): ${reviewedClaim.evidence}\nDecision: ${payload.decision}\nReview note (public): ${payload.note}\nEvidence revision: ${payload.revision}`;
    const message = `Juicy Journey contribution recognition\nDomain: ${host}\nWallet: ${wallet}\nAction: ${input.action}\n${summary}\nNonce: ${randomBytes(24).toString('hex')}\nExpires: ${new Date(expiresAt).toISOString()}\nThis message records a contribution or review. It does not transfer tokens, authorize payments, or grant a cash entitlement.`;
    challenges.set(challengeId, { wallet, action: input.action, payload, host, message, expiresAt });
    return { challengeId, message, expiresAt };
  }
  function perform(input, host) {
    const challenge = typeof input.challengeId === 'string' ? challenges.get(input.challengeId) : null;
    if (challenge) challenges.delete(input.challengeId);
    if (!challenge || challenge.expiresAt <= now() || challenge.host !== host || input.wallet !== challenge.wallet) throw new ProgramError(401, 'This contribution signature expired or belongs to another wallet or app. Request a new signature.');
    let valid = false;
    try {
      const signature = typeof input.signature === 'string' && input.signature.length <= 100 ? bs58.decode(input.signature) : null;
      valid = signature?.length === 64 && nacl.sign.detached.verify(new TextEncoder().encode(challenge.message), signature, walletKey(challenge.wallet).toBytes());
    } catch {}
    if (!valid) throw new ProgramError(401, 'The wallet signature could not be verified.');
    const wallet = challenge.wallet;
    const payload = challenge.payload;
    let claim;
    if (challenge.action === 'submit') {
      const previous = forMission(wallet, payload.missionId);
      if (previous && previous.status !== 'declined') throw new ProgramError(409, previous.status === 'approved' ? 'This mission already earned its permanent Spark stamp.' : 'This mission is already waiting for review.');
      if ((previous?.id || null) !== payload.previousId || (previous?.revision || 0) !== payload.revision) throw new ProgramError(409, 'This contribution changed. Review it and sign a new submission.');
      if (previous) {
        db.prepare("UPDATE program_claims SET evidence=?,status='pending',reviewer=NULL,review_note=NULL,reviewed_at=NULL,created_at=?,revision=revision+1 WHERE id=?").run(payload.evidence, now(), previous.id);
        claim = find(previous.id);
      } else {
        const id = randomUUID();
        db.prepare("INSERT INTO program_claims(id,wallet,mission_id,evidence,status,created_at) VALUES(?,?,?,?,'pending',?)").run(id, wallet, payload.missionId, payload.evidence, now());
        claim = find(id);
      }
    } else {
      if (!reviewers.includes(wallet)) throw new ProgramError(403, 'Only authorized community reviewers can verify contributions.');
      claim = find(payload.claimId);
      if (!claim || claim.revision !== payload.revision) throw new ProgramError(409, 'The completion note changed. Review the new evidence before signing.');
      if (claim.wallet === wallet) throw new ProgramError(403, 'A different authorized reviewer must verify your contribution.');
      if (claim.status === 'approved' && payload.decision !== 'approve') throw new ProgramError(409, 'An earned permanent stamp cannot be declined.');
      if (claim.status === 'declined' && payload.decision === 'approve') throw new ProgramError(409, 'Ask the member to revise and resubmit before approval.');
      const target = payload.decision === 'approve' ? 'approved' : 'declined';
      if (claim.status !== target) {
        db.prepare('UPDATE program_claims SET status=?,reviewer=?,review_note=?,reviewed_at=? WHERE id=?').run(target, wallet, payload.note, now(), claim.id);
        claim = find(claim.id);
      }
    }
    return { claim: publicClaim(claim), progress: progress(claim.wallet) };
  }
  return {
    config,
    async handle(req, res, url) {
      if (url.pathname !== '/api/program' && !url.pathname.startsWith('/api/program/')) return false;
      try {
        if (req.method === 'GET' && url.pathname === '/api/program') {
          const wallet = url.searchParams.has('wallet') ? walletKey(url.searchParams.get('wallet')).toBase58() : null;
          json(res, 200, { program: config(), missions: MISSIONS, claims: db.prepare('SELECT * FROM program_claims ORDER BY created_at DESC,id DESC LIMIT 100').all().map(publicClaim), progress: wallet ? progress(wallet) : null });
        } else if (req.method === 'POST' && ['/api/program/challenge', '/api/program/actions'].includes(url.pathname)) {
          const host = sameOrigin(req);
          rate(req);
          const input = await readJson(req);
          json(res, 200, url.pathname.endsWith('/challenge') ? challenge(input, host) : perform(input, host));
        } else json(res, 404, { error: 'This Juicy Journey endpoint was not found.' });
      } catch (error) {
        json(res, error instanceof ProgramError ? error.status : 500, { error: error instanceof ProgramError ? error.message : 'Juicy Journey is temporarily unavailable. Please try again.' });
      }
      return true;
    },
    close() { challenges.clear(); rates.clear(); db.close(); },
  };
}
