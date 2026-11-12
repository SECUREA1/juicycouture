import bs58 from "bs58";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const IMAGE_PATH = /^\/api\/feed\/images\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.webp$/;

// Images and captions are rendered as data. Wallet approval is requested only
// after an explicit post or delete action, never while loading the public feed.
export function initFeed({ getWallet, subscribe } = {}) {
  const $ = (id) => document.getElementById(id);
  const els = {
    form: $("feed-form"), image: $("feed-image"), caption: $("feed-caption"),
    submit: $("feed-submit"), status: $("feed-status"), posts: $("feed-posts"),
    more: $("feed-load-more"), auth: $("feed-auth-status"),
    refresh: $("feed-refresh"),
  };
  const posts = new Map();
  let nextCursor = null;
  let loading = false;
  let busy = false;
  let destroyed = false;
  let walletRevision = 0;
  let lastWallet = getWallet?.()?.address || null;
  let sessionWallet = null;
  let loaded = false;

  function setStatus(message, kind = "pending") {
    els.status.textContent = message;
    els.status.className = `status ${kind}`;
  }

  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        credentials: "same-origin", cache: "no-store", ...options,
      });
    } catch {
      throw new Error("The community feed could not be reached. Check your connection and try again.");
    }
    let result;
    try { result = await response.json(); }
    catch { throw new Error("The community feed returned an unreadable response. Please try again."); }
    if (!response.ok) throw new Error(result.error || "The community feed request could not be completed.");
    return result;
  }

  function checkWallet(address, revision) {
    if (destroyed || walletRevision !== revision || getWallet?.()?.address !== address) {
      throw new Error("Your wallet changed. Review your post and try again with the wallet you want to use.");
    }
  }

  function controls() {
    const wallet = getWallet?.();
    const connected = Boolean(wallet?.address);
    const canSign = typeof wallet?.signMessage === "function";
    els.auth.textContent = !connected
      ? "Connect your Solana wallet to post an image. Everyone can view the community feed."
      : !canSign
        ? "This wallet can view the feed. Posting requires a wallet that supports message signing."
        : sessionWallet === wallet.address
          ? "Your wallet is verified for posting."
          : "Approve a sign-in message in your wallet when you post. Signing in does not transfer coins.";
    els.submit.disabled = busy || loading || !connected || !canSign;
    els.image.disabled = busy;
    els.caption.disabled = busy;
    els.more.disabled = loading || busy;
    els.refresh.disabled = loading || busy;
    for (const button of els.posts.querySelectorAll('.feed-delete')) button.disabled = loading || busy;
    els.more.hidden = nextCursor === null;
  }

  async function ensureSession(wallet, revision) {
    checkWallet(wallet.address, revision);
    const existing = await request("/api/feed/session");
    checkWallet(wallet.address, revision);
    sessionWallet = existing.wallet || null;
    if (sessionWallet === wallet.address) { controls(); return; }
    if (typeof wallet.signMessage !== "function") throw new Error("Choose a Solana wallet that supports signing a message to post.");
    const challenge = await request("/api/feed/challenge", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: wallet.address }),
    });
    checkWallet(wallet.address, revision);
    if (typeof challenge.challengeId !== "string" || typeof challenge.message !== "string") {
      throw new Error("The sign-in request could not be verified. Please try again.");
    }
    setStatus("Approve the community sign-in message in your wallet. This does not transfer coins.");
    const signature = await wallet.signMessage(new TextEncoder().encode(challenge.message));
    checkWallet(wallet.address, revision);
    if (!(signature instanceof Uint8Array) || signature.length !== 64) {
      throw new Error("Your wallet did not return a valid message signature.");
    }
    const signedIn = await request("/api/feed/session", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId, signature: bs58.encode(signature) }),
    });
    checkWallet(wallet.address, revision);
    if (signedIn.wallet !== wallet.address) throw new Error("Your wallet sign-in could not be verified.");
    sessionWallet = signedIn.wallet;
    controls();
  }

  function renderPosts() {
    els.posts.replaceChildren();
    const walletAddress = getWallet?.()?.address;
    if (loaded && posts.size === 0) {
      const empty = document.createElement("p");
      empty.className = "feed-empty";
      empty.textContent = "The community gallery is waiting for its first moment. Share an image to start the story.";
      els.posts.append(empty);
    }
    for (const post of [...posts.values()].sort((a, b) => b.id - a.id)) {
      if (!Number.isSafeInteger(post.id) || post.id <= 0 || typeof post.author !== "string" || !IMAGE_PATH.test(post.imageUrl || "")) continue;
      const card = document.createElement("article");
      card.className = "feed-card";
      card.dataset.postId = String(post.id);
      const image = document.createElement("img");
      image.src = post.imageUrl;
      image.alt = typeof post.caption === "string" && post.caption ? post.caption.slice(0, 160) : "Community image";
      image.loading = "lazy";
      image.decoding = "async";
      const content = document.createElement("div");
      content.className = "feed-card-content";
      const author = document.createElement("p");
      author.className = "feed-author";
      author.textContent = post.author;
      author.title = "Posting wallet";
      const created = new Date(post.createdAt);
      const time = document.createElement("time");
      time.className = "feed-post-time";
      if (!Number.isNaN(created.getTime())) {
        time.dateTime = created.toISOString();
        time.textContent = created.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      }
      content.append(author, time);
      if (typeof post.caption === "string" && post.caption) {
        const caption = document.createElement("p");
        caption.className = "feed-caption";
        caption.textContent = post.caption;
        content.append(caption);
      }
      if (walletAddress === post.author) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "small-button feed-delete";
        remove.textContent = "Delete my post";
        remove.disabled = busy || loading;
        remove.addEventListener("click", () => { void deletePost(post); });
        content.append(remove);
      }
      card.append(image, content);
      els.posts.append(card);
    }
    if (loaded) document.dispatchEvent(new CustomEvent('jcq:feed', { detail: { count: els.posts.querySelectorAll('.feed-card').length, more: nextCursor !== null } }));
    controls();
  }

  async function load(append = false) {
    if (loading || busy || destroyed) return;
    if (append && nextCursor === null) return;
    loading = true;
    controls();
    try {
      const page = await request(`/api/feed${append ? `?before=${encodeURIComponent(nextCursor)}` : ""}`);
      if (destroyed) return;
      if (!Array.isArray(page.posts) || (page.nextCursor !== null && (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < 1))) {
        throw new Error("The community feed could not be loaded. Please try again.");
      }
      if (!append) posts.clear();
      for (const post of page.posts) posts.set(post.id, post);
      nextCursor = page.nextCursor;
      loaded = true;
      renderPosts();
      setStatus(posts.size ? 'Community photos are up to date. Refresh to check for more moments.' : 'The gallery is ready for its first community photo.');
    } catch (error) {
      if (!destroyed) {
        setStatus(error.message, "error");
        document.dispatchEvent(new CustomEvent('jcq:feed-error'));
      }
    } finally {
      loading = false;
      if (!destroyed) controls();
    }
  }

  async function deletePost(post) {
    if (busy || loading) return;
    const wallet = getWallet?.();
    if (!wallet?.address || wallet.address !== post.author) return;
    const revision = walletRevision;
    busy = true;
    controls();
    renderPosts();
    try {
      await ensureSession(wallet, revision);
      checkWallet(wallet.address, revision);
      await request(`/api/feed/posts/${post.id}`, { method: "DELETE", headers: { "x-post-wallet": wallet.address } });
      posts.delete(post.id);
      document.dispatchEvent(new CustomEvent('jcq:feed-changed'));
      setStatus("Your image post was deleted.", "success");
    } catch (error) {
      setStatus(error.code === 4001 ? "Wallet sign-in cancelled. The post was not deleted." : error.message, "error");
    } finally {
      busy = false;
      renderPosts();
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (busy || loading) return;
    const wallet = getWallet?.();
    if (!wallet?.address || typeof wallet.signMessage !== "function") {
      setStatus("Connect a Solana wallet that supports message signing to post an image.", "error");
      return;
    }
    const file = els.image.files?.[0];
    const caption = els.caption.value.trim();
    if (!file || !IMAGE_TYPES.has(file.type) || file.size === 0 || file.size > MAX_IMAGE_BYTES) {
      setStatus("Choose a JPEG, PNG, or WebP image up to 5 MB.", "error");
      return;
    }
    if (caption.length > 500) { setStatus("Keep your caption to 500 characters or fewer.", "error"); return; }
    const revision = walletRevision;
    busy = true;
    controls();
    renderPosts();
    try {
      await ensureSession(wallet, revision);
      checkWallet(wallet.address, revision);
      setStatus("Uploading your community image…");
      const post = await request("/api/feed/posts", {
        method: "POST", headers: { "content-type": file.type, "x-post-caption": encodeURIComponent(caption), "x-post-wallet": wallet.address }, body: file,
      });
      posts.set(post.id, post);
      document.dispatchEvent(new CustomEvent('jcq:feed-changed'));
      loaded = true;
      els.image.value = "";
      els.caption.value = "";
      setStatus("Your image is posted to the community feed.", "success");
    } catch (error) {
      setStatus(error.code === 4001 ? "Wallet sign-in cancelled. Your image was not posted." : error.message, "error");
    } finally {
      busy = false;
      renderPosts();
    }
  }

  function walletChanged() {
    const address = getWallet?.()?.address || null;
    if (address !== lastWallet) {
      lastWallet = address;
      walletRevision++;
      sessionWallet = null;
    }
    renderPosts();
  }

  els.form.addEventListener("submit", onSubmit);
  const onMore = () => { void load(true); };
  const onRefresh = () => { void load(); };
  els.more.addEventListener("click", onMore);
  els.refresh.addEventListener("click", onRefresh);
  const unsubscribe = subscribe?.(walletChanged);
  controls();
  void load();
  return {
    refresh: () => load(),
    destroy() {
      destroyed = true;
      walletRevision++;
      els.form.removeEventListener("submit", onSubmit);
      els.more.removeEventListener("click", onMore);
      els.refresh.removeEventListener("click", onRefresh);
      if (typeof unsubscribe === "function") unsubscribe();
    },
  };
}
