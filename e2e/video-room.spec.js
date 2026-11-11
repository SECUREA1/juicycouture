import { test, expect } from "@playwright/test";

async function join(page, name, room) {
  await page.goto("/");
  await expect(page.locator("#join-room")).toBeEnabled();
  await page.locator("#display-name").fill(name);
  await page.locator("#room-code").fill(room);
  await page.locator("#join-with-media").check();
  await page.locator("#join-room").click();
  await expect(page.locator("#live-room")).toHaveClass(/connected/);
}

test("two browsers exchange video, audio tracks and chat without credentials", async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL, permissions: ["camera", "microphone"] })));
  const errors = [];
  try {
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
    const room = `browser-${Date.now()}`;
    await join(pages[0], "Alice", room);
    await join(pages[1], "Bob", room);
    for (const page of pages) {
      await expect(page.locator("#participants")).toHaveText("2 people here");
      // Check decoded remote frames and live audio, not just video DOM elements.
      await expect.poll(() => page.evaluate(() => {
        const video = document.querySelector(".video-tile:not(.self) video");
        if (!video?.videoWidth || !video.currentTime
          || !video.srcObject?.getAudioTracks().some((track) => track.readyState === "live")) return false;
        const canvas = document.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        const context = canvas.getContext("2d");
        context.drawImage(video, 0, 0, 16, 16);
        return context.getImageData(0, 0, 16, 16).data.some((value, i) => i % 4 !== 3 && value > 32);
      }), { timeout: 15_000 }).toBe(true);
      // Check actual audio samples from the received stream as well as tracks.
      expect(await page.evaluate(async () => {
        const audio = new AudioContext();
        const source = audio.createMediaStreamSource(document.querySelector(".video-tile:not(.self) video").srcObject);
        const analyser = audio.createAnalyser();
        const mute = audio.createGain();
        mute.gain.value = 0;
        source.connect(analyser).connect(mute).connect(audio.destination);
        await audio.resume();
        const samples = new Float32Array(analyser.fftSize);
        try {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            analyser.getFloatTimeDomainData(samples);
            if (samples.some((value) => Math.abs(value) > 0.001)) return true;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return false;
        } finally { await audio.close(); }
      })).toBe(true);
      await page.evaluate(() => { window.testLocalStream = document.querySelector(".self video").srcObject; });
    }
    const text = "Hello <img src=x onerror=alert(1)>";
    await pages[0].locator("#chat-input").fill(text);
    await pages[0].locator("#chat-form button").click();
    for (const page of pages) {
      await expect(page.locator("#chat-messages li")).toHaveCount(1);
      await expect(page.locator("#chat-messages")).toContainText(text);
      await expect(page.locator("#chat-messages img")).toHaveCount(0);
    }
    await pages[0].locator("#toggle-camera").click();
    await expect(pages[1].locator(".video-tile:not(.self) .video-name")).toContainText("camera off");
    await pages[0].locator("#toggle-mic").click();
    await expect(pages[1].locator(".video-tile:not(.self) .video-name")).toContainText("muted");
    expect(await pages[0].evaluate(() => window.testLocalStream.getTracks().every((track) => !track.enabled))).toBe(true);
    await pages[0].locator("#toggle-camera").click();
    await pages[0].locator("#toggle-mic").click();
    await expect(pages[1].locator(".video-tile:not(.self) .video-name")).toHaveText("Alice");
    await pages[1].locator("#leave-room").click();
    await expect(pages[0].locator("#participants")).toHaveText("1 person here");
    await expect(pages[0].locator("#video-grid video")).toHaveCount(1);
    expect(await pages[1].evaluate(() => window.testLocalStream.getTracks().every((track) => track.readyState === "ended"))).toBe(true);
    await pages[1].locator("#join-room").click();
    await expect(pages[0].locator("#participants")).toHaveText("2 people here");
    await expect(pages[1].locator("#chat-messages li")).toHaveCount(0);
    await pages[0].locator("#leave-room").click();
    await pages[1].locator("#leave-room").click();
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("camera denial gives a useful message and allows another join attempt", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("Denied", "NotAllowedError"); };
  });
  await page.goto("/");
  await page.locator("#display-name").fill("Permission test");
  await expect(page.locator("#join-room")).toBeEnabled();
  await page.locator("#join-with-media").check();
  await page.locator("#join-room").click();
  await expect(page.locator("#room-status")).toContainText("Allow camera and microphone access");
  await expect(page.locator("#join-room")).toBeEnabled();
  await expect(page.locator("#leave-room")).toBeDisabled();
  await expect(page.locator("#video-grid video")).toHaveCount(0);
});

test("losing the room connection stops capture and allows rejoining", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    window.testSockets = [];
    window.WebSocket = class extends NativeSocket {
      constructor(...args) { super(...args); window.testSockets.push(this); }
    };
  });
  await join(page, "Disconnect tester", `disconnect-${Date.now()}`);
  await page.evaluate(() => {
    window.testLocalStream = document.querySelector(".self video").srcObject;
    window.testSockets[0].close();
  });
  await expect(page.locator("#room-status")).toContainText("room connection closed");
  expect(await page.evaluate(() => window.testLocalStream.getTracks().every((track) => track.readyState === "ended"))).toBe(true);
  await expect(page.locator("#join-room")).toBeEnabled();
  await expect(page.locator("#video-grid video")).toHaveCount(0);
});
