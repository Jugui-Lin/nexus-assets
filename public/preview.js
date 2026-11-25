import { MAX_FACES, MAX_VERTICES, MESH_LIMIT_ERROR, parseStl } from './mesh-formats.js';
import { PLY_FORMAT_ERROR, parsePly } from './ply.js';
import { GLTF_FORMAT_ERROR, parseGltf } from './gltf.js';

const DEFAULT_COLOR = '#baa98d';

// OBJ and STL share the same interactive canvas renderer.
export class MeshPreview {
  constructor(canvas, fixedSize = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.yaw = -0.65;
    this.pitch = 0.3;
    this.zoom = 1;
    this.wire = false;
    this.faces = [];
    this.vertices = [];
    this.pendingFrame = null;
    this.fixedSize = fixedSize;
    if (fixedSize) return;
    let drag = null;
    canvas.addEventListener('pointerdown', event => {
      if (drag) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
      if (drag?.id !== event.pointerId) return;
      this.yaw += (event.clientX - drag.x) * 0.012;
      this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch + (event.clientY - drag.y) * 0.009));
      drag.x = event.clientX;
      drag.y = event.clientY;
      this.scheduleDraw();
    });
    const endDrag = event => {
      if (drag?.id === event.pointerId) drag = null;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('lostpointercapture', endDrag);
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      this.zoom = Math.min(3, Math.max(0.35, this.zoom * Math.exp(-event.deltaY * 0.001)));
      this.scheduleDraw();
    }, { passive: false });
    this.observer = new ResizeObserver(() => this.scheduleDraw());
    this.observer.observe(canvas);
  }

  load(text, color = DEFAULT_COLOR) {
    const vertices = [];
    const faces = [];
    for (const line of text.split(/\r?\n/)) {
      const tokens = line.split('#', 1)[0].trim().split(/\s+/);
      const [record, ...values] = tokens;
      if (record === 'v' && values.length >= 3) {
        const point = values.slice(0, 3).map(Number);
        if (point.every(Number.isFinite)) vertices.push(point);
      } else if (record === 'f' && values.length >= 3) {
        const indices = values.map(value => Number(value.split('/', 1)[0]))
          .map(index => index < 0 ? vertices.length + index : index - 1);
        if (indices.every(index => Number.isInteger(index) && index >= 0 && index < vertices.length)) {
          faces.push(indices);
        }
      }
      if (vertices.length > MAX_VERTICES || faces.length > MAX_FACES) throw Error(MESH_LIMIT_ERROR);
    }
    if (!vertices.length || !faces.length) throw Error('OBJ 中未找到可预览的网格');
    return this.loadMesh(vertices, faces, color);
  }

  loadBinary(base64, ext, color = DEFAULT_COLOR) {
    const format = String(ext).toLowerCase();
    const gltf = format === 'gltf' || format === 'glb';
    if (format !== 'stl' && format !== 'ply' && !gltf) throw Error('此格式暂不支持交互预览');
    let raw;
    try {
      raw = atob(base64);
    } catch {
      if (gltf) throw Error(GLTF_FORMAT_ERROR);
      throw Error(format === 'ply' ? PLY_FORMAT_ERROR : 'STL 文件格式无效或数据不完整');
    }
    const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
    if (format === 'ply') {
      const {vertices, faces} = parsePly(bytes);
      if (!vertices.length || !faces.length) throw Error('PLY 中未找到由面组成的网格');
      return this.loadMesh(vertices, faces, color);
    }
    if (gltf) {
      const {vertices, faces} = parseGltf(bytes, format);
      if (!vertices.length || !faces.length) throw Error('glTF 中未找到可预览的三角形网格');
      return this.loadMesh(vertices, faces, color);
    }
    const { vertices, faces } = parseStl(bytes);
    if (!vertices.length || !faces.length) throw Error('STL 中未找到可预览的网格');
    // STL models typically use Z-up. The shared viewer's grid uses Y-up.
    return this.loadMesh(vertices.map(([x, y, z]) => [x, z, -y]), faces, color);
  }

  loadMesh(vertices, faces, color) {
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    for (const vertex of vertices) {
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], vertex[axis]);
        maximum[axis] = Math.max(maximum[axis], vertex[axis]);
      }
    }
    const center = maximum.map((value, axis) => value / 2 + minimum[axis] / 2);
    const radius = Math.max(...maximum.map((value, axis) => value / 2 - minimum[axis] / 2), 0.0005);
    this.vertices = vertices.map(vertex => vertex.map((value, axis) => (value - center[axis]) / radius));
    const hex = /^#[a-f\d]{6}$/i.test(color) ? color : DEFAULT_COLOR;
    const rgb = hex.slice(1).match(/../g).map(value => parseInt(value, 16));
    this.faces = faces.map((indices, order) => {
      const [a, b, c] = indices.slice(0, 3).map(index => this.vertices[index]);
      const u = b.map((value, axis) => value - a[axis]);
      const v = c.map((value, axis) => value - a[axis]);
      const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const length = Math.hypot(...normal) || 1;
      const light = 0.58 + 0.34 * Math.abs((normal[0] * -0.4 + normal[1] * 0.8 + normal[2] * 0.5) / length);
      return { indices, order, depth: 0, fill: `rgb(${rgb.map(value => Math.round(value * light)).join(',')})` };
    });
    this.reset();
    return { vertices: vertices.length, faces: faces.length };
  }

  reset() {
    this.yaw = -0.65;
    this.pitch = 0.3;
    this.zoom = 1;
    this.draw();
  }

  scheduleDraw() {
    if (this.pendingFrame !== null) return;
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = null;
      this.draw();
    });
  }

  draw() {
    if (this.pendingFrame !== null) {
      cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = null;
    }
    const canvas = this.canvas;
    const { width, height } = this.fixedSize || canvas.getBoundingClientRect();
    if (!width || !height) return;
    const dpr = this.fixedSize ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const gradient = ctx.createRadialGradient(width * 0.5, height * 0.4, 5, width * 0.5, height * 0.5, width * 0.7);
    gradient.addColorStop(0, '#384849');
    gradient.addColorStop(1, '#263234');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    const cosYaw = Math.cos(this.yaw);
    const sinYaw = Math.sin(this.yaw);
    const cosPitch = Math.cos(this.pitch);
    const sinPitch = Math.sin(this.pitch);
    const scale = Math.min(width, height) * 0.32 * this.zoom;
    const project = ([x, y, z]) => {
      const horizontal = x * cosYaw - z * sinYaw;
      const depth = x * sinYaw + z * cosYaw;
      return [
        width * 0.5 + horizontal * scale,
        height * 0.52 + (-y * cosPitch + depth * sinPitch) * scale,
        y * sinPitch + depth * cosPitch,
      ];
    };
    ctx.strokeStyle = '#a2c5bb26';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let index = -5; index <= 5; index++) {
      const position = index * 0.4;
      for (const line of [[[position, -1.02, -2], [position, -1.02, 2]], [[-2, -1.02, position], [2, -1.02, position]]]) {
        const [start, end] = line.map(project);
        ctx.moveTo(start[0], start[1]);
        ctx.lineTo(end[0], end[1]);
      }
    }
    ctx.stroke();
    if (!this.vertices.length) return;

    const points = this.vertices.map(project);
    for (const face of this.faces) {
      face.depth = face.indices.reduce((sum, index) => sum + points[index][2], 0) / face.indices.length;
    }
    this.faces.sort((a, b) => a.depth - b.depth || a.order - b.order);
    ctx.lineWidth = this.wire ? 0.65 : 0.45;
    for (const { indices, fill } of this.faces) {
      ctx.beginPath();
      for (let index = 0; index < indices.length; index++) {
        const point = points[indices[index]];
        if (index === 0) ctx.moveTo(point[0], point[1]);
        else ctx.lineTo(point[0], point[1]);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = this.wire ? '#d4eee7aa' : fill;
      ctx.stroke();
    }
  }
}
