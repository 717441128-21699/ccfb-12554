// WebGL2 渲染器：展开图坐标系（毫米），支持平移/缩放/自适应
import type { GridCell, LayoutSolution, Opening, Placement, SeamReport, Slab, SlabCutPlan } from './types';
import { localToWorld } from './geometry';

const VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_uv;
uniform vec2 u_ndcScale;   // 世界单位 → NDC 的缩放
uniform vec2 u_worldCenter;
uniform vec2 u_cam;
out vec2 v_uv;
void main() {
  vec2 p = (a_pos - u_worldCenter + u_cam) * u_ndcScale;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0); // y 轴向下
  v_uv = a_uv;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform int u_mode; // 0 纹理 1 纯色
uniform vec4 u_color;
out vec4 outColor;
void main() {
  if (u_mode == 0) {
    outColor = texture(u_tex, v_uv);
  } else {
    outColor = u_color;
  }
}`;

export interface DrawOptions {
  cells?: GridCell[];
  openings?: Opening[];
  seams?: SeamReport[];
  cutPlans?: SlabCutPlan[];
  showCracks?: boolean;
  showCutLines?: boolean;
  showSeams?: boolean;
  showTexture?: boolean;
}

export class Renderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private textures = new Map<string, WebGLTexture>();
  private cam = { x: 0, y: 0, scale: 1 };
  private worldW = 1000;
  private worldH = 1000;
  private dpr = 1;
  private overlay: HTMLCanvasElement;
  private octx: CanvasRenderingContext2D;
  private baseScale = 1;
  private redrawQueued = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.program = this.buildProgram(VERT, FRAG);
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(6 * 4), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.overlay = document.createElement('canvas');
    this.overlay.style.position = 'absolute';
    this.overlay.style.inset = '0';
    this.overlay.style.pointerEvents = 'none';
    canvas.parentElement!.appendChild(this.overlay);
    this.octx = this.overlay.getContext('2d')!;
    this.bindInteraction();
  }

  private buildProgram(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh) ?? 'shader 编译失败');
      }
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) ?? 'program 链接失败');
    }
    return p;
  }

  async uploadTexture(slab: Slab): Promise<WebGLTexture> {
    const cached = this.textures.get(slab.id);
    if (cached) return cached;
    const img = new Image();
    img.src = slab.frontDataUrl;
    await img.decode();
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(slab.id, tex);
    return tex;
  }

  setWorldSize(w: number, h: number) {
    this.worldW = w;
    this.worldH = h;
    this.resize();
    this.fit();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.overlay.width = this.canvas.width;
    this.overlay.height = this.canvas.height;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.baseScale = Math.min(this.canvas.width / this.worldW, this.canvas.height / this.worldH) * 0.92;
  }

  fit() {
    this.cam = { x: 0, y: 0, scale: this.baseScale };
    this.invalidate();
  }

  /** 世界(毫米) → 覆盖层 css 像素 */
  private toScreenX(wx: number): number {
    const rect = this.canvas.getBoundingClientRect();
    return rect.width / 2 + (wx + this.cam.x - this.worldW / 2) * this.cam.scale;
  }
  private toScreenY(wy: number): number {
    const rect = this.canvas.getBoundingClientRect();
    return rect.height / 2 + (wy + this.cam.y - this.worldH / 2) * this.cam.scale;
  }

  screenToWorld(cssX: number, cssY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const wx = (cssX - rect.width / 2) / this.cam.scale - this.cam.x + this.worldW / 2;
    const wy = (cssY - rect.height / 2) / this.cam.scale - this.cam.y + this.worldH / 2;
    return [wx, wy];
  }

  private bindInteraction() {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.cam.x -= (e.clientX - lastX) / this.cam.scale;
      this.cam.y -= (e.clientY - lastY) / this.cam.scale;
      lastX = e.clientX;
      lastY = e.clientY;
      this.invalidate();
    });
    this.canvas.addEventListener('pointerup', () => { dragging = false; });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      this.cam.scale = Math.max(0.02, Math.min(4, this.cam.scale * factor));
      this.invalidate();
    }, { passive: false });
  }

  startLoop(draw: () => void) {
    const loop = () => {
      if (this.disposed) return;
      if (this.redrawQueued) {
        draw();
        this.redrawQueued = false;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  invalidate() { this.redrawQueued = true; }

  private disposed = false;
  dispose() {
    this.disposed = true;
    this.overlay.remove();
    const gl = this.gl;
    for (const tex of this.textures.values()) gl.deleteTexture(tex);
    this.textures.clear();
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }

  private drawQuad(x: number, y: number, w: number, h: number, uv: number[], color: number[] | null, tex?: WebGLTexture) {
    const gl = this.gl;
    const data = new Float32Array([
      x, y, uv[0], uv[1],
      x + w, y, uv[2], uv[1],
      x + w, y + h, uv[2], uv[3],
      x, y, uv[0], uv[1],
      x + w, y + h, uv[2], uv[3],
      x, y + h, uv[0], uv[3]
    ]);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    gl.useProgram(this.program);
    const sx = 2 * this.cam.scale * this.dpr / this.canvas.width;
    const sy = 2 * this.cam.scale * this.dpr / this.canvas.height;
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_ndcScale'), sx, sy);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_worldCenter'), this.worldW / 2, this.worldH / 2);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_cam'), this.cam.x, this.cam.y);
    if (tex && color === null) {
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_mode'), 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_tex'), 0);
    } else {
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_mode'), 1);
      gl.uniform4fv(gl.getUniformLocation(this.program, 'u_color'), new Float32Array(color ?? [1, 0, 1, 1]));
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** 姿态对应的 UV（图像原点左上，与 geometry.localToWorld 的变换保持一致） */
  private poseUV(p: Placement): [number, number, number, number] {
    let u0 = 0, v0 = 0, u1 = 1, v1 = 1;
    if (p.rot90) {
      // 顺时针 90°：新左上 = 原左下 (0,1)，新右下 = 原右上 (1,0)
      u0 = 0; v0 = 1; u1 = 1; v1 = 0;
    }
    switch (p.flip) {
      case 1: { const t = u0; u0 = u1; u1 = t; break; }
      case 2: {
        let t = u0; u0 = u1; u1 = t;
        t = v0; v0 = v1; v1 = t;
        break;
      }
      case 3: { const t = v0; v0 = v1; v1 = t; break; }
      default: break;
    }
    return [u0, v0, u1, v1];
  }

  drawScene(
    surfaceW: number,
    surfaceH: number,
    placements: (Placement & { cellId: number })[],
    slabsById: Map<string, Slab>,
    opts: DrawOptions
  ) {
    const gl = this.gl;
    gl.clearColor(0.07, 0.08, 0.10, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.drawQuad(0, 0, surfaceW, surfaceH, [0, 0, 1, 1], [0.16, 0.17, 0.20, 1]);

    for (const p of placements) {
      const slab = slabsById.get(p.slabId);
      if (!slab) continue;
      const tex = this.textures.get(slab.id);
      const uv = this.poseUV(p);
      if (tex && opts.showTexture !== false) {
        this.drawQuad(p.x, p.y, p.width, p.height, uv, null, tex);
      } else {
        this.drawQuad(p.x, p.y, p.width, p.height, uv, [0.55, 0.5, 0.45, 0.9]);
      }
    }
    this.drawOverlay(surfaceW, surfaceH, placements, slabsById, opts);
  }

  private drawOverlay(
    surfaceW: number, surfaceH: number,
    placements: (Placement & { cellId: number })[],
    slabsById: Map<string, Slab>,
    opts: DrawOptions
  ) {
    const ctx = this.octx;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.save();
    const tx = (wx: number) => this.toScreenX(wx);
    const ty = (wy: number) => this.toScreenY(wy);
    const s = this.cam.scale;

    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(tx(0), ty(0), surfaceW * s, surfaceH * s);

    if (opts.cells) {
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      for (const c of opts.cells) {
        if (c.skip) continue;
        ctx.strokeRect(tx(c.x), ty(c.y), c.width * s, c.height * s);
      }
    }

    if (opts.openings) {
      for (const op of opts.openings) {
        const x = tx(op.x), y = ty(op.y), w = op.width * s, h = op.height * s;
        ctx.fillStyle = op.type === 'socket' ? 'rgba(255,170,40,0.30)' : 'rgba(30,30,34,0.72)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = op.type === 'socket' ? '#ffb02e' : '#9aa4b2';
        ctx.lineWidth = 1.5;
        ctx.setLineDash(op.type === 'socket' ? [5, 4] : []);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
        ctx.fillStyle = '#e8ecf2';
        ctx.font = '12px sans-serif';
        ctx.fillText(op.label, x + 4, Math.max(14, y - 4));
      }
    }

    if (opts.showSeams && opts.seams) {
      for (const seam of opts.seams) {
        ctx.strokeStyle = seam.withinTolerance ? 'rgba(70,220,130,0.95)' : 'rgba(255,80,80,0.95)';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([8, 5]);
        ctx.beginPath();
        if (seam.kind === 'vertical') {
          ctx.moveTo(tx(seam.at), ty(seam.start));
          ctx.lineTo(tx(seam.at), ty(seam.start + seam.length));
        } else {
          ctx.moveTo(tx(seam.start), ty(seam.at));
          ctx.lineTo(tx(seam.start + seam.length), ty(seam.at));
        }
        ctx.stroke();
        ctx.setLineDash([]);
        const lx = seam.kind === 'vertical' ? tx(seam.at) : tx(seam.start + seam.length / 2);
        const ly = seam.kind === 'vertical' ? ty(seam.start + seam.length / 2) : ty(seam.at);
        ctx.fillStyle = seam.withinTolerance ? '#46dc82' : '#ff5050';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(`${seam.meanDiff.toFixed(1)}mm`, lx + 5, ly);
      }
    }

    if (opts.showCracks) {
      ctx.strokeStyle = 'rgba(255,60,60,0.95)';
      ctx.lineWidth = 2;
      for (const p of placements) {
        const slab = slabsById.get(p.slabId);
        if (!slab || slab.cracks.length === 0) continue;
        for (const crack of slab.cracks) {
          ctx.beginPath();
          crack.points.forEach((pt, i) => {
            const wp = localToWorld(pt, slab, p);
            if (i === 0) ctx.moveTo(tx(wp.x), ty(wp.y));
            else ctx.lineTo(tx(wp.x), ty(wp.y));
          });
          ctx.stroke();
        }
      }
    }

    // 切割刀路：蓝虚线 + 刀序编号
    if (opts.showCutLines && opts.cutPlans) {
      for (const plan of opts.cutPlans) {
        const slab = slabsById.get(plan.slabId)!;
        const p = placements.find((q) => q.slabId === plan.slabId);
        if (!p) continue;
        for (const step of plan.steps) {
          ctx.strokeStyle = 'rgba(80,180,255,0.95)';
          ctx.lineWidth = 1.8;
          ctx.setLineDash([10, 4]);
          for (const line of step.lines) {
            const a = localToWorld(line.from, slab, p);
            const b = localToWorld(line.to, slab, p);
            ctx.beginPath();
            ctx.moveTo(tx(a.x), ty(a.y));
            ctx.lineTo(tx(b.x), ty(b.y));
            ctx.stroke();
          }
          ctx.setLineDash([]);
          const mid = step.lines[0]
            ? localToWorld(step.lines[0].from, slab, p)
            : { x: p.x, y: p.y };
          ctx.fillStyle = '#50b4ff';
          ctx.font = 'bold 12px sans-serif';
          ctx.fillText(`刀${step.order}`, tx(mid.x) + 4, ty(mid.y) - 4);
        }
      }
    }

    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = 'bold 13px sans-serif';
    for (const p of placements) {
      const slab = slabsById.get(p.slabId);
      if (slab) ctx.fillText(slab.code, tx(p.x) + 6, ty(p.y) + 18);
    }
    ctx.restore();
  }
}
