/*
 * Tessera descrambler core (scrv1)
 *
 * Shared by the local test player (player.html) and, later, the browser
 * extension's content script. No dependencies; runs in browsers and Node 20+.
 *
 *   const m = SCRV1.parseShareCode("scrv1:...");      // or a manifest object
 *   const t = await SCRV1.buildTables("passphrase", m);
 *   const r = new SCRV1.Renderer(canvas, m, t);
 *   r.render(videoElement);                            // once per video frame
 */
(function (root) {
  "use strict";

  const enc = (s) => new TextEncoder().encode(s);

  // ---------------------------------------------------------------- manifest
  function parseShareCode(code) {
    code = code.trim();
    if (code.startsWith("{")) return JSON.parse(code);
    if (!code.startsWith("scrv1:")) throw new Error("Not a scrv1 share code");
    let b = code.slice(6).replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    const json = typeof atob === "function"
      ? atob(b)
      : Buffer.from(b, "base64").toString("binary");
    const m = JSON.parse(json);
    if (m.v !== 1) throw new Error("Unsupported scrambler version " + m.v);
    return m;
  }

  // ------------------------------------------------------------ key schedule
  // Must match KeyStream in scramble.py exactly.
  async function makeKeyStream(passphrase, salt) {
    const key = await crypto.subtle.importKey(
      "raw", enc(passphrase), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    let counter = 0;
    const words = [];
    let idx = 0;
    async function refill() {
      const jobs = [];
      for (let k = 0; k < 64; k++) {
        jobs.push(crypto.subtle.sign("HMAC", key, enc(`scrv1|${salt}|${counter++}`)));
      }
      for (const buf of await Promise.all(jobs)) {
        const dv = new DataView(buf);
        for (let i = 0; i < 8; i++) words.push(dv.getUint32(i * 4, false));
      }
    }
    async function nextU32() {
      if (idx >= words.length) await refill();
      return words[idx++];
    }
    async function uniform(n) {
      const limit = Math.floor(4294967296 / n) * n;
      for (;;) {
        const x = await nextU32();
        if (x < limit) return x % n;
      }
    }
    return { nextU32, uniform };
  }

  /** pos[s] = scrambled slot of source tile s; xform[s] in 0..7; inv[s] in {0,1} */
  async function buildTables(passphrase, m) {
    const n = m.cols * m.rows;
    const ks = await makeKeyStream(passphrase, m.salt);
    const perm = new Int32Array(n);
    for (let i = 0; i < n; i++) perm[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = await ks.uniform(i + 1);
      const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
    }
    const xform = new Uint8Array(n);
    const inv = new Uint8Array(n);
    for (let s = 0; s < n; s++) {
      const w = await ks.nextU32();
      xform[s] = w & 7;
      inv[s] = (w >>> 3) & 1;
    }
    return { pos: perm, xform, inv };
  }

  // ---------------------------------------------------------------- renderer
  const VS = `
    attribute vec2 aPos;
    varying vec2 vUV;
    void main() {
      vUV = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5);  // top-left origin
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`;

  // For each output (source) pixel: find its tile, look up the slot it was
  // moved to, undo the tile transform in normalised coords, sample inside
  // the guard band, undo colour inversion.
  const FS = `
    precision highp float;
    uniform sampler2D uVideo;
    uniform sampler2D uTable;   // cols x rows; r,g = slot col,row; b = xform | inv<<3
    uniform vec2 uGrid;         // cols, rows
    uniform float uPadFrac;     // pad / tile
    uniform float uInnerFrac;   // inner / tile
    uniform float uBypass;      // 1.0 = show raw frame
    varying vec2 vUV;
    void main() {
      if (uBypass > 0.5) { gl_FragColor = vec4(texture2D(uVideo, vUV).rgb, 1.0); return; }
      vec2 g = vUV * uGrid;
      vec2 cell = min(floor(g), uGrid - 1.0);
      vec2 a = g - cell;
      vec4 t = floor(texture2D(uTable, (cell + 0.5) / uGrid) * 255.0 + 0.5);
      float xf = mod(t.b, 8.0);
      float inv = floor(t.b / 8.0);
      if (mod(xf, 2.0) > 0.5) a = a.yx;
      if (mod(floor(xf / 2.0), 2.0) > 0.5) a.x = 1.0 - a.x;
      if (floor(xf / 4.0) > 0.5) a.y = 1.0 - a.y;
      vec2 uv = (t.rg + uPadFrac + a * uInnerFrac) / uGrid;
      vec3 c = texture2D(uVideo, uv).rgb;
      if (inv > 0.5) c = 1.0 - c;
      gl_FragColor = vec4(c, 1.0);
    }`;

  class Renderer {
    constructor(canvas, m, tables) {
      if (m.cols > 255 || m.rows > 255) throw new Error("grid too large for 8-bit table");
      const gl = canvas.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: false });
      if (!gl) throw new Error("WebGL not available");
      this.gl = gl; this.canvas = canvas; this.m = m;
      this.bypass = false;

      const prog = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        gl.attachShader(prog, sh);
      }
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      this.prog = prog;

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      const tile = m.inner + 2 * m.pad;
      gl.uniform2f(gl.getUniformLocation(prog, "uGrid"), m.cols, m.rows);
      gl.uniform1f(gl.getUniformLocation(prog, "uPadFrac"), m.pad / tile);
      gl.uniform1f(gl.getUniformLocation(prog, "uInnerFrac"), m.inner / tile);
      this.uBypass = gl.getUniformLocation(prog, "uBypass");

      // lookup table: one texel per source tile
      const n = m.cols * m.rows;
      const data = new Uint8Array(n * 4);
      for (let s = 0; s < n; s++) {
        const slot = tables.pos[s];
        data[s * 4] = slot % m.cols;
        data[s * 4 + 1] = Math.floor(slot / m.cols);
        data[s * 4 + 2] = tables.xform[s] | (tables.inv[s] << 3);
        data[s * 4 + 3] = 255;
      }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.activeTexture(gl.TEXTURE1);
      this.tableTex = this._tex(gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, m.cols, m.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.uniform1i(gl.getUniformLocation(prog, "uTable"), 1);

      gl.activeTexture(gl.TEXTURE0);
      this.videoTex = this._tex(gl.LINEAR);
      gl.uniform1i(gl.getUniformLocation(prog, "uVideo"), 0);
    }

    _tex(filter) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    /** Size the drawing buffer (device pixels). */
    resize(w, h) {
      w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w; this.canvas.height = h;
      }
      this.gl.viewport(0, 0, w, h);
    }

    /** Upload the current video frame and draw it descrambled. */
    render(video) {
      if (video.readyState < 2) return false;
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      gl.uniform1f(this.uBypass, this.bypass ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    }
  }

  const api = { parseShareCode, buildTables, Renderer, version: 1 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SCRV1 = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
