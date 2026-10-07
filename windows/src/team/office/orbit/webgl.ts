// The native WebGL engine: stars as depth-tested points, orbits as lines,
// rings as camera-facing sprites of a texture painted once per colour, and
// the travelling lights. Premultiplied alpha with colour and alpha blended
// apart, so the glows do not darken when the browser composites the canvas.
// Everything the engine draws is handed to it each frame; it keeps only GPU
// resources, and dispose() gives them back.

import { clamp, type Vec3 } from "./layout";
import { paintEnergyRing, rgb, type Star } from "./paint";

export interface GlCamera {
  yaw: number;
  pitch: number;
  distance: number;
  /** Vertical screen offset of the scene's centre, in clip units. */
  offset: number;
}

export interface GlNode {
  position: Vec3;
  color: string;
  dashed: boolean;
  size: number;
  rotation: number;
  intensity: number;
}

export interface GlPacket {
  points: Vec3[];
  color: string;
  /** 0–1 travelling; past 1 the arrival ring widens around `end`. */
  t: number;
  tail: Vec3[];
  end: Vec3;
}

export interface GlFrame {
  camera: GlCamera;
  phase: number;
  glow: number;
  centres: { p: Vec3; color: string }[];
  orbits: { points: Vec3[]; color: string; alpha: number }[];
  nodes: GlNode[];
  selected: Vec3 | null;
  packets: GlPacket[];
}

const COMMON =
  "uniform vec3 uRight,uUp,uNormal;uniform float uDistance,uAspect,uOffset;" +
  "vec4 project3D(vec3 p){float z=uDistance-dot(p,uNormal);return vec4(dot(p,uRight)*2.605089/uAspect,dot(p,uUp)*2.605089+uOffset*z,1.001251*z-.2001251,z);}";

const LINES_V = "attribute vec3 aPosition;attribute vec4 aColour;varying vec4 vColour;" + COMMON + "void main(){vColour=aColour;gl_Position=project3D(aPosition);}";
const LINES_F = "precision mediump float;varying vec4 vColour;void main(){gl_FragColor=vColour;}";
const POINTS_V =
  "attribute vec3 aPosition;attribute vec4 aColour;attribute float aRadius;uniform float uHeight,uPhase;varying vec4 vColour;" + COMMON +
  "void main(){vColour=aColour;float a=uPhase*.0025,c=cos(a),s=sin(a);vec3 p=vec3(aPosition.x*c+aPosition.z*s,aPosition.y+sin(uPhase*.025)*.7,aPosition.z*c-aPosition.x*s);gl_Position=project3D(p);gl_PointSize=clamp(aRadius*uHeight*1.302545/(uDistance-dot(p,uNormal)),1.0,30.0);}";
const POINTS_F = "precision mediump float;varying vec4 vColour;void main(){float r=length(gl_PointCoord-.5)*2.0;float a=pow(max(0.0,1.0-r),1.4);gl_FragColor=vec4(vColour.rgb,vColour.a*a);}";
const SPRITE_V =
  "attribute vec2 aCorner;uniform vec3 uCenter;uniform vec2 uSize;uniform float uRotation;varying vec2 vUV;" + COMMON +
  "void main(){vUV=(aCorner+1.0)*.5;vec2 q=aCorner*uSize*.5;float c=cos(uRotation),s=sin(uRotation);vec2 r=vec2(q.x*c-q.y*s,q.x*s+q.y*c);gl_Position=project3D(uCenter+uRight*r.x+uUp*r.y);}";
const SPRITE_F = "precision mediump float;varying vec2 vUV;uniform sampler2D uTexture;uniform vec4 uTint;void main(){vec4 c=texture2D(uTexture,vUV)*uTint;if(c.a<.004)discard;gl_FragColor=c;}";

export class GlEngine {
  private gl: WebGLRenderingContext;
  private lines: WebGLProgram;
  private points: WebGLProgram;
  private sprite: WebGLProgram;
  private buffer: WebGLBuffer;
  private quad: WebGLBuffer;
  private glowMap: WebGLTexture;
  private rings = new Map<string, WebGLTexture>();
  private locations = new Map<string, WebGLUniformLocation | null>();
  private starData: Float32Array;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private lost = false;
  private onLost: (e: Event) => void;

  /** Throws when WebGL is not there or a shader fails: the caller falls back to Canvas. */
  constructor(readonly surface: HTMLCanvasElement, stars: Star[], onLost: () => void) {
    const gl = surface.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: "low-power" });
    if (!gl) throw new Error("WebGL unavailable");
    this.gl = gl;
    this.lines = this.program(LINES_V, LINES_F);
    this.points = this.program(POINTS_V, POINTS_F);
    this.sprite = this.program(SPRITE_V, SPRITE_F);
    this.buffer = gl.createBuffer()!;
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.glowMap = this.texture((c) => {
      const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, "#ffffffd0");
      g.addColorStop(0.18, "#ffffff72");
      g.addColorStop(0.45, "#ffffff16");
      g.addColorStop(1, "#ffffff00");
      c.fillStyle = g;
      c.fillRect(0, 0, 128, 128);
    });
    this.starData = new Float32Array(stars.flatMap((s) => [...s.p, ...rgb("#c8d7ea", s.a), 0.06 + s.r * 0.03]));
    gl.enable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 0);
    this.onLost = (e) => {
      e.preventDefault();
      this.lost = true;
      onLost();
    };
    surface.addEventListener("webglcontextlost", this.onLost);
  }

  private shader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  }

  private program(v: string, f: string): WebGLProgram {
    const gl = this.gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, this.shader(gl.VERTEX_SHADER, v));
    gl.attachShader(p, this.shader(gl.FRAGMENT_SHADER, f));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "program");
    return p;
  }

  /** A 256 × 256 RGBA texture painted in a 128-unit space, scaled twice; transparent corners. */
  private texture(painter: (c: CanvasRenderingContext2D) => void): WebGLTexture {
    const gl = this.gl;
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const cctx = c.getContext("2d")!;
    cctx.scale(2, 2);
    painter(cctx);
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** The ring of one colour (and look), painted once and shared by every node of that colour. */
  private ring(color: string, dashed: boolean): WebGLTexture {
    const key = `${color}${dashed ? "~" : ""}`;
    let t = this.rings.get(key);
    if (!t) {
      t = this.texture((c) => paintEnergyRing(c, color, 64, 64, 1, 0, 1, dashed));
      this.rings.set(key, t);
    }
    return t;
  }

  private loc(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    const key = `${name}${p === this.lines ? 0 : p === this.points ? 1 : 2}`;
    if (!this.locations.has(key)) this.locations.set(key, this.gl.getUniformLocation(p, name));
    return this.locations.get(key) ?? null;
  }

  private use(p: WebGLProgram, cam: GlCamera) {
    const gl = this.gl;
    gl.useProgram(p);
    const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw), sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
    gl.uniform3f(this.loc(p, "uRight"), cy, 0, -sy);
    gl.uniform3f(this.loc(p, "uUp"), -sp * sy, cp, -sp * cy);
    gl.uniform3f(this.loc(p, "uNormal"), cp * sy, sp, cp * cy);
    gl.uniform1f(this.loc(p, "uDistance"), cam.distance);
    gl.uniform1f(this.loc(p, "uAspect"), this.w / this.h);
    gl.uniform1f(this.loc(p, "uOffset"), cam.offset);
  }

  private vertices(p: WebGLProgram, cam: GlCamera, data: Float32Array | number[], hasRadius: boolean, phase = 0): number {
    const gl = this.gl;
    this.use(p, cam);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data instanceof Float32Array ? data : new Float32Array(data), gl.DYNAMIC_DRAW);
    const stride = (hasRadius ? 8 : 7) * 4;
    const position = gl.getAttribLocation(p, "aPosition"), col = gl.getAttribLocation(p, "aColour");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(col);
    gl.vertexAttribPointer(col, 4, gl.FLOAT, false, stride, 12);
    if (hasRadius) {
      const radius = gl.getAttribLocation(p, "aRadius");
      gl.enableVertexAttribArray(radius);
      gl.vertexAttribPointer(radius, 1, gl.FLOAT, false, stride, 28);
      gl.uniform1f(this.loc(p, "uHeight"), this.h * this.dpr);
      gl.uniform1f(this.loc(p, "uPhase"), phase);
    }
    return data.length / (hasRadius ? 8 : 7);
  }

  private stroke(cam: GlCamera, ps: Vec3[], color: string, alpha: number, loop: boolean) {
    if (ps.length < 2) return;
    const c = rgb(color, alpha);
    const count = this.vertices(this.lines, cam, ps.flatMap((p) => [...p, ...c]), false);
    this.gl.drawArrays(loop ? this.gl.LINE_LOOP : this.gl.LINE_STRIP, 0, count);
  }

  private blend(additive: boolean) {
    const gl = this.gl;
    gl.blendFuncSeparate(gl.SRC_ALPHA, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private drawSprite(cam: GlCamera, center: Vec3, size: [number, number], map: WebGLTexture, tint: [number, number, number, number], additive: boolean, rotation = 0) {
    const gl = this.gl, p = this.sprite;
    this.use(p, cam);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const corner = gl.getAttribLocation(p, "aCorner");
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 8, 0);
    gl.uniform3fv(this.loc(p, "uCenter"), center);
    gl.uniform2fv(this.loc(p, "uSize"), size);
    gl.uniform1f(this.loc(p, "uRotation"), rotation);
    gl.uniform4fv(this.loc(p, "uTint"), tint);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, map);
    gl.uniform1i(this.loc(p, "uTexture"), 0);
    this.blend(additive);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** A circle in the plane facing the camera, around a point. */
  private facingCircle(cam: GlCamera, center: Vec3, radius: number): Vec3[] {
    const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw), sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
    return Array.from({ length: 72 }, (_, i) => {
      const a = (i / 72) * Math.PI * 2, x = Math.cos(a) * radius, y = Math.sin(a) * radius;
      return [center[0] + x * cy - y * sp * sy, center[1] + y * cp, center[2] - x * sy - y * sp * cy];
    });
  }

  resize(w: number, h: number, dpr: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.dpr = dpr;
    this.surface.width = Math.round(this.w * dpr);
    this.surface.height = Math.round(this.h * dpr);
    this.gl.viewport(0, 0, this.surface.width, this.surface.height);
  }

  draw(f: GlFrame) {
    if (this.lost) return;
    const gl = this.gl, cam = f.camera;
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.depthMask(false);
    for (const c of f.centres) this.drawSprite(cam, c.p, [10, 8], this.glowMap, rgb(c.color, 0.1 * f.glow), true);
    this.blend(true);
    const count = this.vertices(this.points, cam, this.starData, true, f.phase);
    gl.drawArrays(gl.POINTS, 0, count);
    this.blend(false);
    for (const o of f.orbits) this.stroke(cam, o.points, o.color, o.alpha, false);
    for (const n of f.nodes) this.drawSprite(cam, n.position, [2.5, 2.5], this.glowMap, rgb(n.color, 0.21 * f.glow), true);
    for (const n of f.nodes) this.drawSprite(cam, n.position, [n.size, n.size], this.ring(n.color, n.dashed), [1, 1, 1, n.intensity], true, n.rotation);
    this.blend(false);
    if (f.selected) this.stroke(cam, this.facingCircle(cam, f.selected, 0.69), "#dcf3ff", 0.85, true);
    for (const p of f.packets) {
      this.stroke(cam, p.points, p.color, 0.45, false);
      if (p.t <= 1) {
        p.tail.forEach((q, k) => this.drawSprite(cam, q, [0.45 - k * 0.025, 0.45 - k * 0.025], this.glowMap, rgb(p.color, (1 - k / 9) * 0.8), true));
      } else {
        this.stroke(cam, this.facingCircle(cam, p.end, 0.28 + (p.t - 1) * 3), p.color, clamp((1.17 - p.t) * 4, 0, 1), true);
      }
    }
  }

  /** Gives the GPU everything back; the canvas can be removed afterwards. */
  dispose() {
    const gl = this.gl;
    this.surface.removeEventListener("webglcontextlost", this.onLost);
    if (this.lost) return;
    for (const t of this.rings.values()) gl.deleteTexture(t);
    this.rings.clear();
    gl.deleteTexture(this.glowMap);
    gl.deleteBuffer(this.buffer);
    gl.deleteBuffer(this.quad);
    gl.deleteProgram(this.lines);
    gl.deleteProgram(this.points);
    gl.deleteProgram(this.sprite);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.lost = true;
  }
}
