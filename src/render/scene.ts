// 场景渲染器:房间盒体(单面朝内)、门窗洞口、灯具符号、工作面伪彩色。
// 阴影采用每盏灯一张正交深度贴图(20 张),直射光用点光源衰减近似;
// 照度数值始终由 CPU 物理引擎计算,渲染只负责可视化。
import {
  createMesh,
  createMeshWithUV,
  drawMesh,
  makeProgram,
  boxGeometry,
  planeGridGeometry,
  cylinderGeometry,
  type GLMesh,
  type ProgramBundle,
} from './gl.ts';
import {
  mat4Identity,
  mat4Invert,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  mat4RotateY,
  mat4Translate,
  type Mat4,
  type Vec3,
} from '../core/math.ts';
import type { Opening, PlacedLight, RoomConfig } from '../core/types.ts';
import { falseColor } from '../core/engine.ts';

const MAX_LIGHTS = 24;

const SCENE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uModel, uViewProj;
uniform mat4 uLightSpace[${MAX_LIGHTS}];
out vec3 vNormal;
out vec3 vWorld;
out vec4 vLightClip[${MAX_LIGHTS}];
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) vLightClip[i] = uLightSpace[i] * world;
  gl_Position = uViewProj * world;
}`;

const SCENE_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec4 vLightClip[${MAX_LIGHTS}];
uniform vec3 uCamPos;
uniform vec3 uBaseColor;
uniform float uReflectance;
uniform float uAlpha;
uniform int uLightCount;
uniform vec3 uLightPos[${MAX_LIGHTS}];
uniform float uLightPower[${MAX_LIGHTS}];
uniform highp sampler2DArray uShadowMap;
uniform int uShadowEnabled;
out vec4 outColor;

float shadowFactor(int idx, vec3 N) {
  vec4 clip = vLightClip[idx];
  vec3 ndc = clip.xyz / clip.w;
  vec3 uvw = vec3(ndc.xy * 0.5 + 0.5, float(idx));
  if (uvw.x < 0.0 || uvw.x > 1.0 || uvw.y < 0.0 || uvw.y > 1.0) return 1.0;
  if (ndc.z > 1.0) return 1.0;
  float bias = max(0.004 * (1.0 - dot(N, normalize(uLightPos[idx] - vWorld))), 0.0015);
  float sum = 0.0;
  // 2x2 PCF
  vec2 texel = 1.0 / vec2(textureSize(uShadowMap, 0).xy);
  for (int x = -1; x <= 1; x += 2) {
    for (int y = -1; y <= 1; y += 2) {
      float depth = texture(uShadowMap, uvw + vec3(vec2(x, y) * texel, 0.0)).r;
      sum += (ndc.z - bias <= depth) ? 1.0 : 0.0;
    }
  }
  return sum * 0.25;
}

vec3 falseColorMap(float t) {
  vec3 c0 = vec3(0.157, 0.188, 0.549);
  vec3 c1 = vec3(0.118, 0.549, 0.824);
  vec3 c2 = vec3(0.235, 0.745, 0.353);
  vec3 c3 = vec3(0.941, 0.784, 0.157);
  vec3 c4 = vec3(0.863, 0.196, 0.157);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 linear = uBaseColor * (0.06 + 0.12 * uReflectance); // 环境底光
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec3 toL = uLightPos[i] - vWorld;
    float dist = length(toL);
    vec3 L = toL / dist;
    float ndl = max(dot(N, L), 0.0);
    float att = uLightPower[i] / (dist * dist);
    float sh = uShadowEnabled == 1 ? shadowFactor(i, N) : 1.0;
    linear += uBaseColor * att * ndl * sh;
  }
  // 简易 Reinhard 色调映射 + gamma
  vec3 mapped = linear / (linear + vec3(1.0));
  outColor = vec4(pow(mapped, vec3(1.0 / 2.2)), uAlpha);
}`;

const GRID_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uViewProj;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const GRID_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uHeat;       // 每格照度纹理(R 通道存 lx)
uniform float uScaleMax;
uniform float uOpacity;
out vec4 outColor;
vec3 falseColorMap(float t) {
  vec3 c0 = vec3(0.157, 0.188, 0.549);
  vec3 c1 = vec3(0.118, 0.549, 0.824);
  vec3 c2 = vec3(0.235, 0.745, 0.353);
  vec3 c3 = vec3(0.941, 0.784, 0.157);
  vec3 c4 = vec3(0.863, 0.196, 0.157);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}
void main() {
  float lux = texture(uHeat, vUV).r;
  float t = clamp(lux / max(uScaleMax, 1.0), 0.0, 1.0);
  outColor = vec4(falseColorMap(t), uOpacity);
}`;

const DEPTH_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uModel;
uniform mat4 uLightSpace;
void main() { gl_Position = uLightSpace * uModel * vec4(aPos, 1.0); }`;
const DEPTH_FS = `#version 300 es
precision highp float;
void main() {}`;

const SHADOW_SIZE = 512;
type SurfaceKind = 'floor' | 'ceiling' | 'wall';

export class SceneRenderer {
  private gl: WebGL2RenderingContext;
  private scene!: ProgramBundle;
  private grid!: ProgramBundle;
  private depth!: ProgramBundle;
  private roomMeshes: GLMesh[] = [];
  private lampMesh!: GLMesh;
  private heatTex: WebGLTexture | null = null;
  private heatDims = { nx: 0, nz: 0 };
  private shadowTex: WebGLTexture;
  private shadowFbo: WebGLFramebuffer;
  private lightSpace: Mat4[] = [];
  private cam = { yaw: 0.85, pitch: 0.55, dist: 8.5, target: [0, 0.5, 0] as Vec3 };
  private viewProj: Mat4 = mat4Identity();
  private drag: { mode: 'orbit' | 'pan' | null; x: number; y: number } = { mode: null, x: 0, y: 0 };

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    gl.enable(gl.DEPTH_TEST);
    // 房间为单面朝内的盒体,需要从外部俯视内部,因此关闭背面剔除
    gl.disable(gl.CULL_FACE);

    this.scene = makeProgram(
      gl, SCENE_VS, SCENE_FS,
      ['uModel', 'uViewProj', 'uLightSpace', 'uCamPos', 'uBaseColor', 'uReflectance', 'uAlpha',
        'uLightCount', 'uLightPos', 'uLightPower', 'uShadowMap', 'uShadowEnabled'],
      ['aPos', 'aNormal'],
    );
    this.grid = makeProgram(gl, GRID_VS, GRID_FS, ['uViewProj', 'uHeat', 'uScaleMax', 'uOpacity'], ['aPos', 'aNormal', 'aUV']);
    this.depth = makeProgram(gl, DEPTH_VS, DEPTH_FS, ['uModel', 'uLightSpace'], ['aPos']);

    const cyl = cylinderGeometry(0.09, 0.12, 18);
    this.lampMesh = createMesh(gl, cyl.vertices, cyl.indices);

    // 阴影纹理数组(一层一盏灯)
    this.shadowTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.shadowTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE, MAX_LIGHTS);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.shadowFbo = gl.createFramebuffer()!;
  }

  /** 构建房间:地面、顶面、四面墙(带洞口的墙拆成矩形条带) */
  buildRoom(room: RoomConfig): void {
    const gl = this.gl;
    this.roomMeshes = [];
    const { width: w, depth: d, height: H } = room;

    const addBox = (bw: number, bh: number, bd: number, x: number, y: number, z: number, kind: SurfaceKind = 'wall') => {
      const geo = boxGeometry(bw, bh, bd);
      const mesh = createMesh(gl, geo.vertices, geo.indices);
      (mesh as GLMesh & { model: Mat4 }).model = mat4Translate(x, y, z);
      (mesh as GLMesh & { kind: SurfaceKind }).kind = kind;
      this.roomMeshes.push(mesh);
    };

    // 地面与顶面:薄板
    addBox(w, 0.05, d, 0, -0.025, 0, 'floor');
    addBox(w, 0.05, d, 0, H + 0.025, 0, 'ceiling');

    // 实心墙
    const t = 0.06;
    const wallDefs = [
      { wall: 0, len: w, make: (u: number, y: number, bw: number, bh: number) => addBox(bw, bh, t, u, y, d / 2) },
      { wall: 1, len: d, make: (u: number, y: number, bw: number, bh: number) => addBox(t, bh, bw, w / 2, y, -u) },
      { wall: 2, len: w, make: (u: number, y: number, bw: number, bh: number) => addBox(bw, bh, t, -u, y, -d / 2) },
      { wall: 3, len: d, make: (u: number, y: number, bw: number, bh: number) => addBox(t, bh, bw, -w / 2, y, u) },
    ];

    for (const def of wallDefs) {
      const holes = room.openings.filter((o) => o.wall === def.wall);
      if (!holes.length) {
        def.make(0, H / 2, def.len, H);
        continue;
      }
      // 沿 u 方向与 y 方向切分,逐块补齐
      const uCuts = [-def.len / 2];
      const yCuts = [0];
      for (const h of holes) {
        uCuts.push(h.u - h.width / 2, h.u + h.width / 2);
        yCuts.push(h.bottom, h.bottom + h.height);
      }
      uCuts.push(def.len / 2);
      yCuts.push(H);
      uCuts.sort((a, b) => a - b);
      yCuts.sort((a, b) => a - b);
      const uEdges = [...new Set(uCuts)];
      const yEdges = [...new Set(yCuts)];
      for (let i = 0; i < uEdges.length - 1; i++) {
        for (let j = 0; j < yEdges.length - 1; j++) {
          const u0 = uEdges[i], u1 = uEdges[i + 1];
          const y0 = yEdges[j], y1 = yEdges[j + 1];
          const uc = (u0 + u1) / 2;
          const yc = (y0 + y1) / 2;
          const inHole = holes.some(
            (h) => uc > h.u - h.width / 2 && uc < h.u + h.width / 2 && yc > h.bottom && yc < h.bottom + h.height,
          );
          if (!inHole) def.make(uc, yc, u1 - u0, y1 - y0);
        }
      }
    }
  }

  /** 把照度网格上传为浮点纹理(R32F,双线性) */
  uploadHeatmap(points: { total: number }[], nx: number, nz: number): void {
    const gl = this.gl;
    if (!this.heatTex || this.heatDims.nx !== nx || this.heatDims.nz !== nz) {
      if (this.heatTex) gl.deleteTexture(this.heatTex);
      this.heatTex = gl.createTexture();
      this.heatDims = { nx, nz };
    }
    // RGBA32F:配合 EXT_color_buffer_float 可读回,且线性过滤由 OES_texture_float_linear 支持
    const data = new Float32Array(nx * nz * 4);
    for (let i = 0; i < points.length; i++) {
      data[i * 4] = points[i].total;
      data[i * 4 + 3] = 1;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.heatTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // points 行序为 z 从远到近;WebGL 纹理第 0 行在底部,翻转使 UV(v=iz/nz) 与世界 z 对齐
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, nx, nz, 0, gl.RGBA, gl.FLOAT, data);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private renderShadowMaps(room: RoomConfig, lights: PlacedLight[]): void {
    const gl = this.gl;
    this.lightSpace = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.colorMask(false, false, false, false);
    gl.useProgram(this.depth.program);
    const extent = Math.max(room.width, room.depth) * 0.75;

    lights.forEach((light, i) => {
      if (i >= MAX_LIGHTS) return;
      const lp = light.position;
      // 俯视正交投影,相机在灯上方朝下
      const view = mat4LookAt([lp[0], lp[1] + 1, lp[2]], [lp[0], 0, lp[2]], [0, 0, -1]);
      const proj = ortho(-extent, extent, -extent, extent, 0.05, room.height + 2);
      const ls = mat4Multiply(proj, view);
      this.lightSpace.push(ls);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, this.shadowTex, 0, i);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(this.depth.uniforms.uLightSpace, false, ls);
      for (const mesh of this.roomMeshes) {
        const model = (mesh as GLMesh & { model?: Mat4 }).model ?? mat4Identity();
        gl.uniformMatrix4fv(this.depth.uniforms.uModel, false, model);
        drawMesh(gl, mesh);
      }
    });
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  render(
    room: RoomConfig,
    lights: PlacedLight[],
    powers: number[],
    opts: { falseColor: boolean; scaleMax: number; selectedId: string | null; showHeat: boolean },
  ): void {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const Hpx = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== W || canvas.height !== Hpx) {
      canvas.width = W;
      canvas.height = Hpx;
    }
    gl.viewport(0, 0, W, Hpx);
    gl.clearColor(0.07, 0.09, 0.13, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const activeLights = lights.slice(0, MAX_LIGHTS);
    if (activeLights.length) this.renderShadowMaps(room, activeLights);
    while (this.lightSpace.length < MAX_LIGHTS) this.lightSpace.push(mat4Identity());

    // 相机
    const aspect = W / Hpx;
    const proj = mat4Perspective((50 * Math.PI) / 180, aspect, 0.05, 100);
    const cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw);
    const cp = Math.cos(this.cam.pitch), sp = Math.sin(this.cam.pitch);
    const eye: Vec3 = [
      this.cam.target[0] + this.cam.dist * cp * sy,
      this.cam.target[1] + this.cam.dist * sp,
      this.cam.target[2] + this.cam.dist * cp * cy,
    ];
    const view = mat4LookAt(eye, this.cam.target, [0, 1, 0]);
    this.viewProj = mat4Multiply(proj, view);

    // 房间盒体
    gl.useProgram(this.scene.program);
    gl.uniformMatrix4fv(this.scene.uniforms.uViewProj, false, this.viewProj);
    const lsFlat = new Float32Array(16 * MAX_LIGHTS);
    this.lightSpace.forEach((m, i) => lsFlat.set(m, i * 16));
    gl.uniformMatrix4fv(this.scene.uniforms.uLightSpace, false, lsFlat);
    gl.uniform3fv(this.scene.uniforms.uCamPos, new Float32Array(eye));
    gl.uniform1i(this.scene.uniforms.uLightCount, activeLights.length);
    const posArr = new Float32Array(MAX_LIGHTS * 3);
    const powArr = new Float32Array(MAX_LIGHTS);
    activeLights.forEach((l, i) => {
      posArr.set(l.position, i * 3);
      powArr[i] = powers[i] ?? 1;
    });
    gl.uniform3fv(this.scene.uniforms.uLightPos, posArr);
    gl.uniform1fv(this.scene.uniforms.uLightPower, powArr);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.shadowTex);
    gl.uniform1i(this.scene.uniforms.uShadowMap, 0);
    gl.uniform1i(this.scene.uniforms.uShadowEnabled, activeLights.length ? 1 : 0);

    const surfaceStyle: Record<SurfaceKind, { color: [number, number, number]; refl: number }> = {
      floor: { color: [0.45, 0.42, 0.38], refl: room.reflectance.floor },
      ceiling: { color: [0.92, 0.92, 0.9], refl: room.reflectance.ceiling },
      wall: { color: [0.8, 0.8, 0.78], refl: room.reflectance.wall },
    };
    const drawSurface = (mesh: GLMesh): void => {
      const kind = (mesh as GLMesh & { kind?: SurfaceKind }).kind ?? 'wall';
      const model = (mesh as GLMesh & { model?: Mat4 }).model ?? mat4Identity();
      const s = surfaceStyle[kind];
      gl.uniformMatrix4fv(this.scene.uniforms.uModel, false, model);
      gl.uniform3fv(this.scene.uniforms.uBaseColor, new Float32Array(s.color));
      gl.uniform1f(this.scene.uniforms.uReflectance, s.refl);
      drawMesh(gl, mesh);
    };

    // 第一遍:地面与墙(不透明)
    gl.uniform1f(this.scene.uniforms.uAlpha, 1);
    for (const mesh of this.roomMeshes) {
      const kind = (mesh as GLMesh & { kind?: SurfaceKind }).kind ?? 'wall';
      if (kind !== 'ceiling') drawSurface(mesh);
    }

    // 灯具符号
    activeLights.forEach((light) => {
      const model = mat4Multiply(
        mat4Translate(light.position[0], light.position[1], light.position[2]),
        mat4RotateY((light.yawDeg * Math.PI) / 180),
      );
      gl.uniformMatrix4fv(this.scene.uniforms.uModel, false, model);
      const selected = light.id === opts.selectedId;
      gl.uniform3fv(this.scene.uniforms.uBaseColor, new Float32Array(selected ? [1, 0.75, 0.2] : [0.2, 0.25, 0.35]));
      gl.uniform1f(this.scene.uniforms.uReflectance, 0.4);
      gl.uniform1f(this.scene.uniforms.uAlpha, 1);
      drawMesh(gl, this.lampMesh);
    });

    // 第二遍:顶板半透明,俯视时可看穿
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.uniform1f(this.scene.uniforms.uAlpha, 0.14);
    for (const mesh of this.roomMeshes) {
      if ((mesh as GLMesh & { kind?: SurfaceKind }).kind === 'ceiling') drawSurface(mesh);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // 工作面伪彩色
    if (opts.showHeat && this.heatTex) {
      this.renderHeatGrid(room, opts.scaleMax, opts.falseColor ? 0.82 : 0.35);
    }
  }

  private heatMesh: GLMesh | null = null;
  private heatDimsRoom = '';
  private renderHeatGrid(room: RoomConfig, scaleMax: number, opacity: number): void {
    const gl = this.gl;
    const key = `${room.width}x${room.depth}x${room.workplaneHeight}`;
    if (!this.heatMesh || this.heatDimsRoom !== key) {
      if (this.heatMesh) {
        gl.deleteVertexArray(this.heatMesh.vao);
        gl.deleteBuffer(this.heatMesh.vbo);
      }
      const geo = planeGridGeometry(room.width, room.depth, this.heatDims.nx, this.heatDims.nz, room.workplaneHeight + 0.01);
      this.heatMesh = createMeshWithUV(gl, geo.vertices, geo.indices);
      this.heatDimsRoom = key;
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.useProgram(this.grid.program);
    gl.uniformMatrix4fv(this.grid.uniforms.uViewProj, false, this.viewProj);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heatTex);
    gl.uniform1i(this.grid.uniforms.uHeat, 0);
    gl.uniform1f(this.grid.uniforms.uScaleMax, scaleMax);
    gl.uniform1f(this.grid.uniforms.uOpacity, opacity);
    drawMesh(gl, this.heatMesh);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  // ---------------- 交互 ----------------

  attachControls(canvas: HTMLCanvasElement, onPick: (world: Vec3) => void, onDrag: (world: Vec3) => void): void {
    canvas.addEventListener('mousedown', (e) => {
      this.drag = { mode: e.button === 2 || e.shiftKey ? 'pan' : 'orbit', x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.drag.mode) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      if (this.drag.mode === 'orbit') {
        this.cam.yaw -= dx * 0.008;
        this.cam.pitch = Math.max(0.08, Math.min(1.45, this.cam.pitch + dy * 0.006));
      } else {
        const s = this.cam.dist * 0.0018;
        this.cam.target[0] -= dx * s * Math.cos(this.cam.yaw);
        this.cam.target[2] -= dx * s * Math.sin(this.cam.yaw);
        this.cam.target[1] = Math.max(0, this.cam.target[1] + dy * s);
      }
    });
    window.addEventListener('mouseup', () => (this.drag.mode = null));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.dist = Math.max(2, Math.min(30, this.cam.dist * (1 + Math.sign(e.deltaY) * 0.08)));
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // 单击拾取灯具 / 地面落点
    canvas.addEventListener('click', (e) => {
      if (Math.abs(e.clientX - (this.clickStart?.x ?? -999)) > 4) return;
      const ray = this.screenRay(canvas, e.clientX, e.clientY);
      const hit = this.raycastLights(ray) ?? this.raycastFloor(ray);
      if (hit) onPick(hit);
    });
    canvas.addEventListener('mousedown', (e) => {
      this.clickStart = { x: e.clientX, y: e.clientY };
    });
    // 拖动灯具:由外部在选中后调用 beginLightDrag
    canvas.addEventListener('mousemove', (e) => {
      if (!this.lightDragging) return;
      const ray = this.screenRay(canvas, e.clientX, e.clientY);
      const floor = this.raycastPlane(ray, this.lightDragHeight);
      if (floor) onDrag(floor);
    });
    window.addEventListener('mouseup', () => (this.lightDragging = false));
  }

  private clickStart?: { x: number; y: number };
  private lightDragging = false;
  private lightDragHeight = 0;
  beginLightDrag(height: number): void {
    this.lightDragging = true;
    this.lightDragHeight = height;
  }

  private screenRay(canvas: HTMLCanvasElement, cx: number, cy: number): { o: Vec3; d: Vec3 } {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((cx - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((cy - rect.top) / rect.height) * 2;
    const inv = invertMat(this.viewProj);
    const near = unproject(inv, ndcX, ndcY, -1);
    const far = unproject(inv, ndcX, ndcY, 1);
    const dir: Vec3 = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
    const l = Math.hypot(...dir);
    return { o: near, d: [dir[0] / l, dir[1] / l, dir[2] / l] };
  }

  private raycastPlane(ray: { o: Vec3; d: Vec3 }, y: number): Vec3 | null {
    if (Math.abs(ray.d[1]) < 1e-6) return null;
    const t = (y - ray.o[1]) / ray.d[1];
    if (t < 0) return null;
    return [ray.o[0] + ray.d[0] * t, y, ray.o[2] + ray.d[2] * t];
  }

  private raycastFloor(ray: { o: Vec3; d: Vec3 }): Vec3 | null {
    return this.raycastPlane(ray, 0);
  }

  private raycastLights(ray: { o: Vec3; d: Vec3 }): Vec3 | null {
    // 简单球体拾取,半径 0.25
    let best: { p: Vec3; t: number } | null = null;
    for (const m of this.lastLightPositions) {
      const ox = ray.o[0] - m[0], oy = ray.o[1] - m[1], oz = ray.o[2] - m[2];
      const b = ox * ray.d[0] + oy * ray.d[1] + oz * ray.d[2];
      const c = ox * ox + oy * oy + oz * oz - 0.25 * 0.25;
      const disc = b * b - c;
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t > 0 && (!best || t < best.t)) best = { p: m, t };
    }
    return best?.p ?? null;
  }

  lastLightPositions: Vec3[] = [];
  setLightPositions(p: Vec3[]): void {
    this.lastLightPositions = p;
  }
}

function ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l);
  m[5] = 2 / (t - b);
  m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l);
  m[13] = -(t + b) / (t - b);
  m[14] = -(f + n) / (f - n);
  m[15] = 1;
  return m;
}

function invertMat(m: Mat4): Mat4 {
  return mat4Invert(m) ?? mat4Identity();
}
function unproject(inv: Mat4, x: number, y: number, z: number): Vec3 {
  const v = new Float32Array([x, y, z, 1]);
  const out = new Float32Array(4);
  for (let r = 0; r < 4; r++) {
    out[r] = inv[r] * v[0] + inv[4 + r] * v[1] + inv[8 + r] * v[2] + inv[12 + r] * v[3];
  }
  return [out[0] / out[3], out[1] / out[3], out[2] / out[3]];
}

export { falseColor };
export type { Opening };
