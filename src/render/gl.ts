// 手写 WebGL2 基础:shader 编译、程序链接、网格缓冲封装。
export interface GLMesh {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ebo: WebGLBuffer | null;
  vertexCount: number;
  mode: number;
}

export function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建 shader');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader 编译失败: ${log}\n${src}`);
  }
  return shader;
}

export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 program');
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program 链接失败: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

export interface ProgramBundle {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  attribs: Record<string, number>;
}

export function makeProgram(
  gl: WebGL2RenderingContext,
  vs: string,
  fs: string,
  uniformNames: string[],
  attribNames: string[],
): ProgramBundle {
  const program = createProgram(gl, vs, fs);
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
  const attribs: Record<string, number> = {};
  for (const name of attribNames) attribs[name] = gl.getAttribLocation(program, name);
  return { program, uniforms, attribs };
}

/** 交错顶点:position(3) + normal(3) */
export function createMesh(
  gl: WebGL2RenderingContext,
  vertices: Float32Array,
  indices: Uint16Array | Uint32Array | null,
  mode = gl.TRIANGLES,
): GLMesh {
  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  const stride = 6 * 4;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);

  let ebo: WebGLBuffer | null = null;
  let vertexCount = vertices.length / 6;
  if (indices) {
    ebo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    vertexCount = indices.length;
  }
  gl.bindVertexArray(null);
  return { vao, vbo, ebo, vertexCount, mode };
}

export function drawMesh(gl: WebGL2RenderingContext, mesh: GLMesh): void {
  gl.bindVertexArray(mesh.vao);
  if (mesh.ebo) {
    const idxType = mesh.vertexCount > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    gl.drawElements(mesh.mode, mesh.vertexCount, idxType, 0);
  } else {
    gl.drawArrays(mesh.mode, 0, mesh.vertexCount);
  }
}

// ---------------- 过程式几何 ----------------

export function boxGeometry(
  w: number,
  h: number,
  d: number,
): { vertices: Float32Array; indices: Uint16Array } {
  const hw = w / 2, hh = h / 2, hd = d / 2;
  // 6 面 ×4 顶点,每顶点 pos+normal
  const faces: Array<{ n: [number, number, number]; corners: [number, number, number][] }> = [
    { n: [1, 0, 0], corners: [[hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd], [hw, -hh, hd]] },
    { n: [-1, 0, 0], corners: [[-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd], [-hw, -hh, -hd]] },
    { n: [0, 1, 0], corners: [[-hw, hh, -hd], [-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd]] },
    { n: [0, -1, 0], corners: [[-hw, -hh, hd], [-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd]] },
    { n: [0, 0, 1], corners: [[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]] },
    { n: [0, 0, -1], corners: [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]] },
  ];
  const vertices: number[] = [];
  const indices: number[] = [];
  faces.forEach((face, fi) => {
    for (const c of face.corners) vertices.push(...c, ...face.n);
    const base = fi * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

/** 在 XZ 平面的细分网格(用于工作面伪彩色),带高度 y。
 * 顶点布局:position(3)+normal(3)+uv(2),uv 与房间平面坐标对齐(u:X, v:Z)。 */
export function planeGridGeometry(
  width: number,
  depth: number,
  nx: number,
  nz: number,
  y: number,
): { vertices: Float32Array; indices: Uint32Array } {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let iz = 0; iz <= nz; iz++) {
    for (let ix = 0; ix <= nx; ix++) {
      const x = -width / 2 + (ix / nx) * width;
      const z = -depth / 2 + (iz / nz) * depth;
      const u = ix / nx;
      const v = iz / nz;
      vertices.push(x, y, z, 0, 1, 0, u, v);
    }
  }
  const row = nx + 1;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iz * row + ix;
      indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

/** 为带 uv(8 浮点步长)的平面网格创建 VAO */
export function createMeshWithUV(
  gl: WebGL2RenderingContext,
  vertices: Float32Array,
  indices: Uint32Array,
): GLMesh {
  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  const strideBytes = 8 * 4;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, strideBytes, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, strideBytes, 3 * 4);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, strideBytes, 6 * 4);
  const ebo = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, vbo, ebo, vertexCount: indices.length, mode: gl.TRIANGLES };
}

/** 圆柱(灯具符号),沿 Y 轴 */
export function cylinderGeometry(
  radius: number,
  height: number,
  segments = 20,
): { vertices: Float32Array; indices: Uint16Array } {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = Math.cos(a), z = Math.sin(a);
    // 侧面两顶点(下/上)
    vertices.push(x * radius, -height / 2, z * radius, x, 0, z);
    vertices.push(x * radius, height / 2, z * radius, x, 0, z);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, b, c, b, d, c);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}
