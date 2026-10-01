// WebGL2 compositor: source frame -> fit to the frame -> effect stack -> overlays -> timed effects -> transition.
// The same code renders the live preview and every exported frame, so what you see is what you get.
import { buildFragment, effectById, transitionById, packParams } from "./effects.js";

const VERT = `#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main(){ v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const BASE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_src; uniform vec2 u_srcSize; uniform vec2 u_res; uniform int u_fit; uniform float u_has;
uniform vec4 u_xf; // zoom, panX, panY, rotation(rad)
in vec2 v_uv; out vec4 outColor;
vec2 fitUV(vec2 uv, bool cover){
  float ra = u_res.x / u_res.y, sa = u_srcSize.x / u_srcSize.y;
  vec2 s = vec2(1.0);
  if (cover == (sa > ra)) s.x = ra / sa; else s.y = sa / ra;
  return (uv - 0.5) * s + 0.5;
}
vec3 blurBg(vec2 uv){
  vec3 c = vec3(0.0); float w = 0.0;
  for (int i = -3; i <= 3; i++) for (int j = -3; j <= 3; j++) {
    vec2 o = vec2(float(i), float(j)) * 0.012;
    float k = exp(-float(i*i + j*j) / 8.0);
    c += texture(u_src, clamp(uv + o, 0.0, 1.0), 2.0).rgb * k; w += k;
  }
  return c / w;
}
void main(){
  if (u_has < 0.5) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 uv = v_uv - 0.5;
  float asp = u_res.x / u_res.y;
  uv.x *= asp;
  float cs = cos(u_xf.w), sn = sin(u_xf.w);
  uv = mat2(cs, -sn, sn, cs) * uv;
  uv /= max(0.05, u_xf.x);
  uv -= u_xf.yz;
  uv.x /= asp;
  uv += 0.5;
  if (u_fit == 1) { vec2 c = fitUV(uv, true); outColor = vec4(texture(u_src, clamp(c, 0.0, 1.0)).rgb, 1.0); return; }
  vec2 f = fitUV(uv, false);
  bool inside = all(greaterThanEqual(f, vec2(0.0))) && all(lessThanEqual(f, vec2(1.0)));
  if (inside) { outColor = vec4(texture(u_src, f).rgb, 1.0); return; }
  if (u_fit == 2) { outColor = vec4(blurBg(fitUV(uv, true)) * 0.55, 1.0); return; }
  outColor = vec4(0.0, 0.0, 0.0, 1.0);
}`;

const OVER_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex; uniform sampler2D u_ov; in vec2 v_uv; out vec4 outColor;
void main(){ vec4 b = texture(u_tex, v_uv); vec4 o = texture(u_ov, v_uv); outColor = vec4(mix(b.rgb, o.rgb, o.a), 1.0); }`;

const COPY_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex; in vec2 v_uv; out vec4 outColor;
void main(){ outColor = vec4(texture(u_tex, v_uv).rgb, 1.0); }`;

export class Compositor {
  constructor(canvas, { preserve = false } = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, alpha: false, antialias: false, preserveDrawingBuffer: preserve, powerPreference: "high-performance" });
    if (!gl) throw new Error("This browser has no WebGL2, which FrightCut needs. Use a recent Chrome, Edge or Safari.");
    this.gl = gl;
    this.programs = new Map();
    this.failed = new Set();
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.base = this.program("__base", BASE_FRAG);
    this.over = this.program("__over", OVER_FRAG);
    this.copy = this.program("__copy", COPY_FRAG);
    this.srcTex = this.texture(true);
    this.ovTex = this.texture(false);
    this.fbos = [];
    this.prevIdx = 0;
    this.w = 0; this.h = 0;
  }

  program(key, frag) {
    if (this.programs.has(key)) return this.programs.get(key);
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error(`${key}: ${log}`); }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(p, 0, "a_pos"); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${key}: ${gl.getProgramInfoLog(p)}`);
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    const prog = { p, u };
    this.programs.set(key, prog);
    return prog;
  }

  effectProgram(kind, id) {
    const key = kind + ":" + id;
    if (this.failed.has(key)) return null;
    try {
      if (this.programs.has(key)) return this.programs.get(key);
      const def = kind === "tr" ? transitionById(id) : effectById(id);
      if (!def) { this.failed.add(key); return null; }
      return this.program(key, buildFragment(def.glsl));
    } catch (e) { console.warn("effect failed to compile", key, e); this.failed.add(key); return null; }
  }

  texture(mip) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return t;
  }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    const gl = this.gl;
    this.canvas.width = w; this.canvas.height = h; this.w = w; this.h = h;
    for (const f of this.fbos) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
    this.fbos = [];
    for (let i = 0; i < 4; i++) {
      const tex = this.texture(false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      this.fbos.push({ fb, tex });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resetFeedback() {
    const gl = this.gl;
    for (const f of this.fbos) { gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  upload(tex, src, flip, mip) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  draw(prog, target, setup) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, this.w, this.h);
    gl.bindVertexArray(this.vao);
    setup(prog.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  bindTex(unit, tex, loc) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); if (loc) gl.uniform1i(loc, unit); }

  // frame = { src, srcW, srcH, fit:'blur'|'cover'|'contain', xf:{zoom,x,y,rot}, t,
  //           pre:[fx], overlay: canvas|null, post:[fx], transition:{type,prog,side}|null }
  // fx = { type, params, local, dur, seed }
  render(frame) {
    const gl = this.gl;
    const prev = this.fbos[2 + this.prevIdx], outFinal = this.fbos[2 + (1 - this.prevIdx)];
    let a = this.fbos[0], b = this.fbos[1];
    const has = !!frame.src;
    if (has) this.upload(this.srcTex, frame.src, true, true);
    const xf = frame.xf || {};
    this.draw(this.base, a, u => {
      this.bindTex(0, this.srcTex, u.u_src);
      gl.uniform2f(u.u_srcSize, frame.srcW || 1, frame.srcH || 1);
      gl.uniform2f(u.u_res, this.w, this.h);
      gl.uniform1i(u.u_fit, frame.fit === "cover" ? 1 : frame.fit === "contain" ? 0 : 2);
      gl.uniform1f(u.u_has, has ? 1 : 0);
      gl.uniform4f(u.u_xf, xf.zoom || 1, xf.x || 0, xf.y || 0, xf.rot || 0);
    });

    const runFx = (list, kind = "fx") => {
      for (const fx of list) {
        const prog = this.effectProgram(kind, fx.type);
        if (!prog) continue;
        const def = kind === "tr" ? transitionById(fx.type) : effectById(fx.type);
        const pk = kind === "tr" ? { amt: 1, p: [0, 0, 0, 0] } : packParams(def, fx.params || {});
        if (kind !== "tr" && pk.amt <= 0.0001) continue;
        this.draw(prog, b, u => {
          this.bindTex(0, a.tex, u.u_tex);
          this.bindTex(1, prev.tex, u.u_prev);
          gl.uniform2f(u.u_res, this.w, this.h);
          gl.uniform1f(u.u_time, frame.t || 0);
          gl.uniform1f(u.u_local, fx.local || 0);
          gl.uniform1f(u.u_dur, fx.dur || 0);
          gl.uniform1f(u.u_amt, pk.amt);
          gl.uniform4f(u.u_p, pk.p[0] || 0, pk.p[1] || 0, pk.p[2] || 0, pk.p[3] || 0);
          gl.uniform1f(u.u_seed, fx.seed ?? 0.5);
          gl.uniform1f(u.u_prog, fx.prog ?? 0);
          gl.uniform1f(u.u_side, fx.side ?? 0);
        });
        [a, b] = [b, a];
      }
    };
    runFx(frame.pre || []);
    if (frame.overlay) {
      this.upload(this.ovTex, frame.overlay, true, false);
      this.draw(this.over, b, u => { this.bindTex(0, a.tex, u.u_tex); this.bindTex(1, this.ovTex, u.u_ov); });
      [a, b] = [b, a];
    }
    runFx(frame.post || []);
    if (frame.transition) runFx([{ type: frame.transition.type, prog: frame.transition.prog, side: frame.transition.side, local: 0, dur: 0, seed: 0.5 }], "tr");
    this.draw(this.copy, outFinal, u => this.bindTex(0, a.tex, u.u_tex));
    this.draw(this.copy, null, u => this.bindTex(0, outFinal.tex, u.u_tex));
    this.prevIdx = 1 - this.prevIdx;
  }
}
