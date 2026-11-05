/*
 * Tessera — content script (Phase 1 prototype)
 *
 * On a YouTube watch or embed page whose video ID has a saved share code + key,
 * lays a WebGL canvas exactly over the <video> and redraws every decoded frame
 * descrambled. YouTube's own controls, captions and seeking keep working on top.
 *
 * Shortcut: Alt+Shift+D flips between descrambled and raw.
 */
(() => {
  "use strict";
  const S = globalThis.SCRV1;
  if (!S) return;

  let store = { enabled: true, videos: {} };
  let state = null;          // active session, see attach()
  let syncing = false, again = false;
  let lastHref = "", lastVideo = null;

  // ------------------------------------------------------------- helpers
  function videoIdFromUrl(href) {
    try {
      const u = new URL(href);
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:embed|live)\/([\w-]{6,})/);
      if (m) return m[1];
    } catch (_) { /* ignore */ }
    return null;
  }

  function findVideo() {
    return document.querySelector(".html5-video-player video.html5-main-video") ||
           document.querySelector(".html5-video-player video") ||
           null;
  }

  function playerOf(video) {
    return video.closest(".html5-video-player") || video.parentElement;
  }

  function banner(text, ms) {
    if (!state) return;
    const b = state.banner;
    b.textContent = text;
    b.style.display = text ? "block" : "none";
    clearTimeout(state.bannerTimer);
    if (ms) state.bannerTimer = setTimeout(() => { if (state) b.style.display = "none"; }, ms);
  }

  // ------------------------------------------------------------- session
  async function attach(id, entry, video) {
    const m = S.parseShareCode(entry.code);
    const tables = await S.buildTables(entry.key, m);
    // The page may have moved on while the key schedule ran.
    if (videoIdFromUrl(location.href) !== id || findVideo() !== video) return;

    const canvas = document.createElement("canvas");
    canvas.className = "tessera-canvas";
    Object.assign(canvas.style, {
      position: "absolute", left: "0", top: "0", pointerEvents: "none", display: "block",
      visibility: "hidden",
    });
    video.insertAdjacentElement("afterend", canvas);

    const player = playerOf(video);
    const bannerEl = document.createElement("div");
    bannerEl.className = "tessera-banner";
    Object.assign(bannerEl.style, {
      position: "absolute", top: "12px", left: "12px", zIndex: "70", display: "none",
      padding: "6px 10px", borderRadius: "6px", background: "rgba(0,0,0,0.72)", color: "#fff",
      font: "500 13px/1.3 system-ui, sans-serif", pointerEvents: "none", maxWidth: "70%",
    });
    player.appendChild(bannerEl);

    let renderer;
    try {
      renderer = new S.Renderer(canvas, m, tables);
    } catch (e) {
      canvas.remove(); bannerEl.remove();
      console.warn("[Tessera] WebGL unavailable:", e);
      return;
    }

    const cinematics = document.querySelector("#cinematics");
    state = {
      id, video, canvas, renderer, m, player, banner: bannerEl, bannerTimer: 0,
      code: entry.code, key: entry.key, raw: false, rvfc: 0, raf: 0,
      pipWas: video.disablePictureInPicture,
      cinematics, cinematicsDisplay: cinematics ? cinematics.style.display : "",
      lowWarned: false,
    };

    video.disablePictureInPicture = true;            // PiP would show the raw stream
    if (cinematics) cinematics.style.display = "none"; // ambient glow samples raw frames

    state.ro = new ResizeObserver(draw);
    state.ro.observe(video);
    for (const ev of ["seeked", "loadeddata", "resize"]) video.addEventListener(ev, draw);

    const loop = () => {
      if (!state || state.video !== video) return;
      draw();
      state.rvfc = video.requestVideoFrameCallback(loop);
    };
    if ("requestVideoFrameCallback" in video) {
      state.rvfc = video.requestVideoFrameCallback(loop);
    } else {
      const tick = () => { if (!state || state.video !== video) return; if (!video.paused) draw(); state.raf = requestAnimationFrame(tick); };
      state.raf = requestAnimationFrame(tick);
    }
    draw();
    banner("Descrambling on · Alt+Shift+D to compare", 2500);
  }

  function teardown() {
    if (!state) return;
    const s = state;
    state = null;
    if (s.rvfc && s.video.cancelVideoFrameCallback) s.video.cancelVideoFrameCallback(s.rvfc);
    if (s.raf) cancelAnimationFrame(s.raf);
    s.ro && s.ro.disconnect();
    for (const ev of ["seeked", "loadeddata", "resize"]) s.video.removeEventListener(ev, draw);
    s.video.disablePictureInPicture = s.pipWas;
    if (s.cinematics) s.cinematics.style.display = s.cinematicsDisplay;
    clearTimeout(s.bannerTimer);
    s.canvas.remove();
    s.banner.remove();
    const ext = s.renderer.gl.getExtension("WEBGL_lose_context");
    if (ext) ext.loseContext();
  }

  // ------------------------------------------------------------- drawing
  function layout() {
    const { video, canvas } = state;
    const vw = video.videoWidth, vh = video.videoHeight;
    const ew = video.clientWidth, eh = video.clientHeight;
    if (!vw || !vh || !ew || !eh) return false;
    // The picture's box inside the <video> element (object-fit: contain).
    const s = Math.min(ew / vw, eh / vh);
    const cw = vw * s, ch = vh * s;
    canvas.style.left = `${video.offsetLeft + (ew - cw) / 2}px`;
    canvas.style.top = `${video.offsetTop + (eh - ch) / 2}px`;
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    const dpr = window.devicePixelRatio || 1;
    state.renderer.resize(cw * dpr, ch * dpr);
    return true;
  }

  function draw() {
    if (!state) return;
    const { video, canvas, player } = state;
    const ad = player.classList.contains("ad-showing");
    if (ad || state.raw) { canvas.style.visibility = "hidden"; return; }
    if (!layout()) return;
    try {
      if (state.renderer.render(video)) canvas.style.visibility = "visible";
    } catch (e) {
      // SecurityError = the page will not let us read the video's pixels.
      console.warn("[Tessera] cannot read video frames:", e);
      const b = state.banner;
      teardown();
      document.querySelector(".html5-video-player")?.appendChild(b);
      b.textContent = "Tessera: this video's frames cannot be read in this browser.";
      b.style.display = "block";
      setTimeout(() => b.remove(), 8000);
      return;
    }
    if (video.videoHeight && video.videoHeight < 720 && !state.lowWarned) {
      state.lowWarned = true;
      banner(`Playing ${video.videoHeight}p — set quality to 720p or higher for a clear picture`, 6000);
    } else if (video.videoHeight >= 720 && state.lowWarned) {
      state.lowWarned = false;
    }
  }

  // ------------------------------------------------------------- wiring
  async function sync() {
    if (syncing) { again = true; return; }
    syncing = true;
    try {
      const id = videoIdFromUrl(location.href);
      const entry = store.enabled && id ? store.videos[id] : null;
      const video = findVideo();
      if (!entry || !video) { teardown(); return; }
      if (state && state.id === id && state.video === video &&
          state.code === entry.code && state.key === entry.key) return;
      teardown();
      await attach(id, entry, video);
    } catch (e) {
      console.warn("[Tessera]", e);
    } finally {
      syncing = false;
      if (again) { again = false; sync(); }
    }
  }

  chrome.storage.local.get({ enabled: true, videos: {} }, (s) => { store = s; sync(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.videos) store.videos = changes.videos.newValue || {};
    if (changes.enabled) store.enabled = changes.enabled.newValue !== false;
    sync();
  });

  // YouTube is a single-page app: catch its navigation event, plus a cheap
  // poll in case the event or the <video> element changes without notice.
  document.addEventListener("yt-navigate-finish", sync);
  setInterval(() => {
    const v = findVideo();
    if (location.href !== lastHref || v !== lastVideo) {
      lastHref = location.href; lastVideo = v; sync();
    }
  }, 1000);

  document.addEventListener("keydown", (e) => {
    if (!state || !(e.altKey && e.shiftKey && e.code === "KeyD")) return;
    e.preventDefault(); e.stopPropagation();
    state.raw = !state.raw;
    banner(state.raw ? "Showing raw (scrambled)" : "Descrambling on", 1500);
    draw();
  }, true);
})();
