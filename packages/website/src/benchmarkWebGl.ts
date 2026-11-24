const vertexSource = `
attribute vec2 position;

void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const getFragmentSource = (columnCount: number) => {
  const result = `
precision mediump float;

uniform vec2 resolution;
uniform float heights[${columnCount}];

vec3 barColor(int column) {
  if (column == 0) return vec3(0.36, 0.91, 0.69);
  if (column == 1) return vec3(0.39, 0.58, 0.85);
  if (column == 2) return vec3(0.95, 0.60, 0.40);
  return vec3(0.87, 0.76, 0.42);
}

void main() {
  vec2 point = gl_FragCoord.xy / resolution;
  vec2 depth = vec2(0.021, 0.044);
  float width = 0.56 / float(${columnCount});
  vec4 pixel = vec4(0.0);

  for (int column = 0; column < ${columnCount}; column++) {
    float center = (float(column) + 0.5) / float(${columnCount});
    float left = center - (width + depth.x) / 2.0;
    float right = left + width;
    float top = heights[column] * 0.95;
    if (top <= 0.0) continue;

    vec3 color = barColor(column);

    if (point.x >= left && point.x <= right && point.y <= top) {
      float light = smoothstep(0.0, top, point.y);
      float edge = step(1.5 / resolution.x, min(point.x - left, right - point.x));
      vec3 face = mix(color * 0.34, color, light);
      pixel = vec4(mix(color, face, edge * 0.92), 1.0);
    }

    float side = (point.x - right) / depth.x;
    if (side > 0.0 && side <= 1.0 && point.y >= side * depth.y && point.y <= top + side * depth.y) {
      float light = smoothstep(0.0, top, point.y - side * depth.y);
      pixel = vec4(mix(color * 0.22, color * 0.59, light), 1.0);
    }

    float cap = (point.y - top) / depth.y;
    if (cap > 0.0 && cap <= 1.0 && point.x >= left + cap * depth.x && point.x <= right + cap * depth.x) {
      pixel = vec4(mix(color, vec3(0.87, 0.98, 0.95), 0.42 + cap * 0.20), 1.0);
    }
  }

  gl_FragColor = pixel;
}
`;

  return result;
};

const compileShader = ({ gl, type, source }: { gl: WebGLRenderingContext; type: number; source: string }) => {
  const shader = gl.createShader(type);
  if (!shader) return null;

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;

  gl.deleteShader(shader);
  return null;
};

type BenchmarkRendererOptions = { canvas: HTMLCanvasElement; columnCount: number };

export const createBenchmarkRenderer = ({ canvas, columnCount }: BenchmarkRendererOptions) => {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: false, powerPreference: 'low-power' });
  if (!gl) return null;

  const vertex = compileShader({ gl, type: gl.VERTEX_SHADER, source: vertexSource });
  const fragment = compileShader({ gl, type: gl.FRAGMENT_SHADER, source: getFragmentSource(columnCount) });
  const program = gl.createProgram();
  const buffer = gl.createBuffer();

  if (!vertex || !fragment || !program || !buffer) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    gl.deleteProgram(program);
    gl.deleteBuffer(buffer);
    return null;
  }

  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    gl.deleteBuffer(buffer);
    return null;
  }

  const position = gl.getAttribLocation(program, 'position');
  const resolution = gl.getUniformLocation(program, 'resolution');
  const heights = gl.getUniformLocation(program, 'heights[0]');

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let values = Array<number>(columnCount).fill(0);
  let frame = 0;

  const draw = () => {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(canvas.clientWidth * pixelRatio);
    const height = Math.round(canvas.clientHeight * pixelRatio);
    if (!width || !height || gl.isContextLost()) return;

    if (canvas.width !== width) canvas.width = width;

    if (canvas.height !== height) canvas.height = height;

    gl.viewport(0, 0, width, height);
    gl.uniform2f(resolution, width, height);
    gl.uniform1fv(heights, values);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (canvas.dataset.renderer !== 'webgl') canvas.dataset.renderer = 'webgl';
  };

  const animateTo = (target: number[]) => {
    cancelAnimationFrame(frame);

    if (reducedMotion.matches) {
      values = target;
      draw();
      return;
    }

    const initial = values;
    let started: number | undefined;

    const step = (now: number) => {
      started ??= now;

      const progress = Math.min(Math.max(now - started, 0) / 550, 1);
      const fraction = 1 - (1 - progress) ** 3;

      values = initial.map((value, index) => value + (target[index] - value) * fraction);
      draw();

      if (progress < 1) frame = requestAnimationFrame(step);
    };

    draw();
    frame = requestAnimationFrame(step);
  };

  const dispose = () => {
    cancelAnimationFrame(frame);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    delete canvas.dataset.renderer;
  };

  const result = { draw, animateTo, dispose };
  return result;
};
