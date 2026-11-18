import type { Placement, Slab, Surface, Vec2 } from '../core/types';

const VERT = `#version 300 es
in vec2 a_pos;       // 世界坐标(mm)，由 uniform 缩放到裁剪空间
in vec2 a_uv;        // 纹理坐标
uniform vec2 u_surfaceSize;
uniform vec2 u_viewport;
out vec2 v_uv;
void main() {
  vec2 ndc = vec2(
    (a_pos.x / u_surfaceSize.x) * 2.0 - 1.0,
    1.0 - (a_pos.y / u_surfaceSize.y) * 2.0
  );
  // 等比适配视口，居中留边
  float sx = u_surfaceSize.x / u_viewport.x;
  float sy = u_surfaceSize.y / u_viewport.y;
  float s = max(sx, sy);
  ndc.x *= sx / s;
  ndc.y *= sy / s;
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_alpha;
uniform int u_hasTex;
uniform vec3 u_tint;
out vec4 outColor;
void main() {
  if (u_hasTex == 1) {
    outColor = texture(u_tex, v_uv) * vec4(1.0, 1.0, 1.0, u_alpha);
  } else {
    outColor = vec4(u_tint, u_alpha);
  }
}`;

const LINE_VERT = `#version 300 es
in vec2 a_pos;
uniform vec2 u_surfaceSize;
uniform vec2 u_viewport;
void main() {
  vec2 ndc = vec2(
    (a_pos.x / u_surfaceSize.x) * 2.0 - 1.0,
    1.0 - (a_pos.y / u_surfaceSize.y) * 2.0
  );
  float sx = u_surfaceSize.x / u_viewport.x;
  float sy = u_surfaceSize.y / u_viewport.y;
  float s = max(sx, sy);
  ndc.x *= sx / s;
  ndc.y *= sy / s;
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }`;

interface TextureEntry {
  tex: WebGLTexture;
  url: string;
  ready: boolean;
}

export interface RendererOptions {
  /** 纹理异步上传完成后的回调，供宿主触发重绘 */
  onDirty?: () => void;
  /** 需要高亮的接缝，值为 placement id 的集合 */
  highlightPlacementIds?: Set<string>;
}

/**
 * WebGL2 版面渲染器。
 * 世界坐标统一毫米；板照片作为纹理，旋转/镜像通过 UV 变换在 GPU 完成。
 * 线框（接缝、开口、裂纹、切割线）用独立的 GL_LINES 程序绘制。
 */
export class WebGLRenderer {
  private gl: WebGL2RenderingContext;
  private quadProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private textures = new Map<string, TextureEntry>();
  private vao: WebGLVertexArrayObject;
  private quadBuffer: WebGLBuffer;
  private lineBuffer: WebGLBuffer;
  private dpr = 1;
  private onDirty?: () => void;

  constructor(private canvas: HTMLCanvasElement, opts?: RendererOptions) {
    this.onDirty = opts?.onDirty;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.quadProg = this.createProgram(VERT, FRAG);
    this.lineProg = this.createProgram(LINE_VERT, LINE_FRAG);
    this.vao = gl.createVertexArray()!;
    this.quadBuffer = gl.createBuffer()!;
    this.lineBuffer = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private createProgram(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('shader 编译失败: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('program 链接失败: ' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  /** 加载/复用板照片纹理，URL 变化时自动回收旧纹理；未就绪返回 null */
  private getTexture(slab: Slab): WebGLTexture | null {
    const url = slab.images.front.url;
    if (!url) return null; // 持久化恢复后照片未重新导入
    const cached = this.textures.get(slab.id);
    if (cached && cached.url === url) return cached.ready ? cached.tex : null;
    const gl = this.gl;
    const tex = gl.createTexture()!;
    const entry: TextureEntry = { tex, url, ready: false };
    if (cached) gl.deleteTexture(cached.tex);
    this.textures.set(slab.id, entry);

    const img = new Image();
    img.onload = () => {
      this.uploadTexture(tex, img);
      entry.ready = true;
      this.onDirty?.();
    };
    img.onerror = () => {
      // 加载失败不保留无效纹理，避免后续误用
      gl.deleteTexture(tex);
      this.textures.delete(slab.id);
    };
    img.src = url;
    return null;
  }

  private uploadTexture(tex: WebGLTexture, img: HTMLImageElement): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (w <= 0 || h <= 0) return; // 画布隐藏时跳过，等下一次渲染
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(
    surface: Surface,
    placements: Placement[],
    slabById: Map<string, Slab>,
    opts: {
      highlightSeam?: string;
      showCracks: boolean;
      showOpenings: boolean;
      crackPolylines?: { placement: Placement; points: Vec2[] }[];
      cutLines?: Vec2[];
    },
  ): void {
    this.resize();
    if (this.canvas.width === 0 || this.canvas.height === 0) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.965, 0.96, 0.95, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 板
    gl.useProgram(this.quadProg);
    this.setUniform2f('u_surfaceSize', surface.width, surface.height);
    this.setUniform2f('u_viewport', this.canvas.width / this.dpr, this.canvas.height / this.dpr);
    for (const p of placements) {
      const slab = slabById.get(p.slabId);
      if (!slab) continue;
      const tex = this.getTexture(slab);
      this.drawQuad(p, tex);
    }

    // 叠加元素
    const lines: number[] = [];
    const highlightLines: number[] = [];
    this.collectSeamLines(placements, lines, opts.highlightSeam, highlightLines);
    if (opts.showOpenings) this.collectOpeningLines(surface, lines);
    if (opts.showCracks && opts.crackPolylines) {
      for (const c of opts.crackPolylines) this.collectPolyline(c.points, lines);
    }
    this.drawLines(lines, surface, [0.85, 0.18, 0.15, 0.95]);
    if (highlightLines.length > 0) {
      // 高亮接缝：粗亮黄色，压在普通线之上
      this.drawLines(highlightLines, surface, [1, 0.78, 0.1, 1]);
    }

    // 切割线：醒目的橙色，最后绘制压在最上层
    if (opts.cutLines && opts.cutLines.length > 0) {
      const cut: number[] = [];
      this.collectPolyline(opts.cutLines, cut);
      this.drawLines(cut, surface, [0.95, 0.45, 0.05, 1]);
    }
  }

  private drawQuad(p: Placement, tex: WebGLTexture | null): void {
    const gl = this.gl;
    // 朝向局部 UV：通过翻转/交换 UV 表达 flipX 与 90° 旋转
    const uv = this.orientedUV(p.rot, p.flipX);
    const x0 = p.x;
    const y0 = p.y;
    const x1 = p.x + p.width;
    const y1 = p.y + p.height;
    // 每个顶点: pos.xy + uv.xy，两个三角形
    const data = [
      x0, y0, uv[0].x, uv[0].y,
      x1, y0, uv[1].x, uv[1].y,
      x1, y1, uv[3].x, uv[3].y,
      x0, y0, uv[0].x, uv[0].y,
      x1, y1, uv[3].x, uv[3].y,
      x0, y1, uv[2].x, uv[2].y,
    ];
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    const loc = gl.getAttribLocation(this.quadProg, 'a_pos');
    const uvLoc = gl.getAttribLocation(this.quadProg, 'a_uv');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

    gl.uniform1i(gl.getUniformLocation(this.quadProg, 'u_hasTex'), tex ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.quadProg, 'u_alpha'), 1);
    gl.uniform3f(gl.getUniformLocation(this.quadProg, 'u_tint'), 0.82, 0.8, 0.76);
    if (tex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(this.quadProg, 'u_tex'), 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** 8 种朝向对应的四角 UV（顺序：左上、右上、右下、左下） */
  private orientedUV(rot: Placement['rot'], flipX: boolean): [Vec2, Vec2, Vec2, Vec2] {
    // 基础四角（纹理已 UNPACK_FLIP_Y，UV 原点在左上）
    const tl: Vec2 = { x: 0, y: 0 };
    const tr: Vec2 = { x: 1, y: 0 };
    const br: Vec2 = { x: 1, y: 1 };
    const bl: Vec2 = { x: 0, y: 1 };
    let corners = [tl, tr, br, bl];
    if (flipX) corners = corners.map((c) => ({ x: 1 - c.x, y: c.y }));
    // 旋转：在 UV 空间顺时针轮转角点
    const rot90 = (cs: Vec2[]) => [cs[3], cs[0], cs[1], cs[2]];
    const times = rot / 90;
    for (let i = 0; i < times; i++) corners = rot90(corners);
    return corners as [Vec2, Vec2, Vec2, Vec2];
  }

  private collectSeamLines(
    placements: Placement[],
    out: number[],
    highlightSeam: string | undefined,
    highlightOut: number[],
  ): void {
    const highlightIds = highlightSeam
      ? new Set(highlightSeam.split('|'))
      : null;
    const seg = (p: Placement, x0: number, y0: number, x1: number, y1: number) => {
      const target = highlightIds && highlightIds.has(p.id) ? highlightOut : out;
      target.push(x0, y0, x1, y1);
    };
    for (const p of placements) {
      // 每个 placement 画边框，相邻边重合即呈现为接缝
      seg(p, p.x, p.y, p.x + p.width, p.y);
      seg(p, p.x + p.width, p.y, p.x + p.width, p.y + p.height);
      seg(p, p.x + p.width, p.y + p.height, p.x, p.y + p.height);
      seg(p, p.x, p.y + p.height, p.x, p.y);
    }
  }

  private collectOpeningLines(surface: Surface, out: number[]): void {
    for (const o of surface.openings) {
      const x0 = o.x;
      const y0 = o.y;
      const x1 = o.x + o.width;
      const y1 = o.y + o.height;
      out.push(x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0);
      // 避让区虚线用对角交叉示意
      const m = o.margin;
      if (m > 0) {
        out.push(x0 - m, y0 - m, x1 + m, y1 + m, x1 + m, y0 - m, x0 - m, y1 + m);
      }
    }
  }

  private collectPolyline(points: Vec2[], out: number[]): void {
    for (let i = 0; i < points.length - 1; i++) {
      out.push(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y);
    }
  }

  private drawLines(vertices: number[], surface: Surface, rgba: number[]): void {
    if (vertices.length === 0) return;
    const gl = this.gl;
    gl.useProgram(this.lineProg);
    this.setUniform2fLine('u_surfaceSize', surface.width, surface.height);
    this.setUniform2fLine('u_viewport', this.canvas.width / this.dpr, this.canvas.height / this.dpr);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
    const loc = gl.getAttribLocation(this.lineProg, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4fv(gl.getUniformLocation(this.lineProg, 'u_color'), new Float32Array(rgba));
    gl.drawArrays(gl.LINES, 0, vertices.length / 2);
  }

  private setUniform2f(name: string, x: number, y: number): void {
    this.gl.uniform2f(this.gl.getUniformLocation(this.quadProg, name), x, y);
  }
  private setUniform2fLine(name: string, x: number, y: number): void {
    this.gl.uniform2f(this.gl.getUniformLocation(this.lineProg, name), x, y);
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.textures.values()) gl.deleteTexture(t.tex);
    this.textures.clear();
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteBuffer(this.lineBuffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.quadProg);
    gl.deleteProgram(this.lineProg);
  }
}
