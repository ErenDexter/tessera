(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  function videoIdFromUrl(href) {
    try {
      const u = new URL(href);
      if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:embed|live|shorts)\/([\w-]{6,})/);
      if (m) return m[1];
    } catch (_) { /* ignore */ }
    return null;
  }

  function say(text, cls) { $("msg").textContent = text; $("msg").className = cls || ""; }

  function render(videos) {
    const ul = $("list");
    ul.textContent = "";
    const ids = Object.keys(videos).sort((a, b) => (videos[b].added || 0) - (videos[a].added || 0));
    if (!ids.length) {
      const li = document.createElement("li");
      li.className = "empty"; li.textContent = "None yet.";
      ul.appendChild(li);
      return;
    }
    for (const id of ids) {
      const li = document.createElement("li");
      const left = document.createElement("div");
      const idEl = document.createElement("div"); idEl.className = "id"; idEl.textContent = id;
      left.appendChild(idEl);
      if (videos[id].label) {
        const l = document.createElement("div"); l.className = "label"; l.textContent = videos[id].label;
        left.appendChild(l);
      }
      const del = document.createElement("button");
      del.textContent = "Remove";
      del.addEventListener("click", () => {
        chrome.storage.local.get({ videos: {} }, (s) => {
          delete s.videos[id];
          chrome.storage.local.set({ videos: s.videos }, () => render(s.videos));
        });
      });
      li.append(left, del);
      ul.appendChild(li);
    }
  }

  chrome.storage.local.get({ enabled: true, videos: {} }, (s) => {
    $("enabled").checked = s.enabled !== false;
    render(s.videos);
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs && tabs[0] && tabs[0].url ? videoIdFromUrl(tabs[0].url) : null;
    if (id) $("vid").value = id;
  });

  $("enabled").addEventListener("change", () => chrome.storage.local.set({ enabled: $("enabled").checked }));

  $("save").addEventListener("click", async () => {
    try {
      const raw = $("vid").value.trim();
      const id = videoIdFromUrl(raw) || raw;
      if (!/^[\w-]{6,}$/.test(id)) throw new Error("Enter a YouTube video ID or URL");
      const code = $("code").value.trim();
      const m = SCRV1.parseShareCode(code);       // validates the share code
      const key = $("key").value;
      if (!key) throw new Error("Enter the key");
      await SCRV1.buildTables(key, m);            // fails fast on a bad manifest
      chrome.storage.local.get({ videos: {} }, (s) => {
        s.videos[id] = { code, key, label: $("label").value.trim(), added: Date.now() };
        chrome.storage.local.set({ videos: s.videos }, () => {
          render(s.videos);
          $("key").value = "";
          say("Saved. The open YouTube tab updates by itself.", "ok");
        });
      });
    } catch (e) {
      say(e.message, "bad");
    }
  });
})();
