import {MAX_FACES, MAX_VERTICES, MESH_LIMIT_ERROR} from './mesh-formats.js';

export const GLTF_FORMAT_ERROR = 'glTF / GLB 文件格式无效或数据不完整';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const indexTypes = new Map([[5121, [1, 'getUint8']], [5123, [2, 'getUint16']], [5125, [4, 'getUint32']]]);
const embed = /^data:application\/(?:octet-stream|gltf-buffer);base64$/i;

function invalid() {
  throw Error(GLTF_FORMAT_ERROR);
}

function decodeJson(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch {
    invalid();
  }
}

function readGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 ||
      view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== view.byteLength) invalid();
  let json;
  let binary;
  let offset = 12;
  while (offset < view.byteLength) {
    if (offset + 8 > view.byteLength) invalid();
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const end = offset + 8 + length;
    if (length % 4 || end > view.byteLength || (offset === 12 && type !== 0x4e4f534a)) invalid();
    const data = bytes.subarray(offset + 8, end);
    if (type === 0x4e4f534a) {
      if (offset !== 12) invalid();
      json = decodeJson(data);
    } else if (type === 0x004e4942) {
      if (binary) invalid();
      binary = data;
    }
    offset = end;
  }
  return {json, binary};
}

function nonnegative(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function objectAt(list, index) {
  const value = Array.isArray(list) && list[nonnegative(index)];
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}

function bufferReader(json, binary) {
  const buffers = new Map();
  return index => {
    if (buffers.has(index)) return buffers.get(index);
    const {uri, byteLength} = objectAt(json.buffers, index);
    const length = nonnegative(byteLength);
    let data;
    if (uri === undefined && index === 0 && binary) {
      data = binary;
      if (data.byteLength - length > 3) invalid();
    } else if (typeof uri === 'string') {
      const comma = uri.indexOf(',');
      if (comma < 0 || !embed.test(uri.slice(0, comma))) {
        throw Error('此预览需要内嵌网格数据，请使用 GLB 或内嵌版 glTF');
      }
      try {
        data = Uint8Array.from(atob(uri.slice(comma + 1)), character => character.charCodeAt(0));
      } catch {
        invalid();
      }
    } else invalid();
    if (data.byteLength < length) invalid();
    const view = new DataView(data.buffer, data.byteOffset, length);
    buffers.set(index, view);
    return view;
  };
}

function accessor(json, loadBuffer, index, type) {
  const attr = objectAt(json.accessors, index);
  if (attr.type !== type || attr.normalized) invalid();
  if (attr.sparse) throw Error('带稀疏访问器的 glTF 暂不可交互预览');
  const position = type === 'VEC3';
  const component = position
    ? (attr.componentType === 5126 && [4, 'getFloat32'])
    : indexTypes.get(attr.componentType);
  if (!component) throw Error('此 glTF 网格使用暂不可预览的几何编码');
  const [size, getter] = component;
  const width = position ? size * 3 : size;
  const bufferView = objectAt(json.bufferViews, attr.bufferView);
  if (bufferView.extensions?.EXT_meshopt_compression) throw Error('此 glTF 网格使用 Meshopt 压缩');
  const view = loadBuffer(bufferView.buffer);
  const base = nonnegative(bufferView.byteOffset ?? 0);
  const length = nonnegative(bufferView.byteLength);
  const offset = nonnegative(attr.byteOffset ?? 0);
  const stride = nonnegative(bufferView.byteStride ?? width);
  const count = nonnegative(attr.count);
  if (bufferView.byteStride !== undefined && (!position || stride > 252)) invalid();
  if (count === 0 || stride < width || stride % size !== 0 ||
      offset % size !== 0 || (base + offset) % size !== 0 ||
      base + length > view.byteLength || offset + (count - 1) * stride + width > length) invalid();
  return {
    count,
    read(row, axis = 0) { return view[getter](base + offset + row * stride + axis * size, true); },
  };
}

function vector(value, length) {
  if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) invalid();
  return value;
}

function transform(node) {
  if (node.matrix !== undefined) {
    const matrix = vector(node.matrix, 16);
    if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) invalid();
    return matrix;
  }
  const [tx, ty, tz] = vector(node.translation ?? [0, 0, 0], 3);
  const [sx, sy, sz] = vector(node.scale ?? [1, 1, 1], 3);
  const rotation = vector(node.rotation ?? [0, 0, 0, 1], 4);
  const magnitude = Math.hypot(...rotation);
  if (!magnitude || !Number.isFinite(magnitude)) invalid();
  const [x, y, z, w] = rotation.map(value => value / magnitude);
  // glTF stores column-major matrices and applies scale, rotation, then translation.
  return [
    sx * (1 - 2 * (y*y + z*z)), sx * 2 * (x*y + z*w), sx * 2 * (x*z - y*w), 0,
    sy * 2 * (x*y - z*w), sy * (1 - 2 * (x*x + z*z)), sy * 2 * (y*z + x*w), 0,
    sz * 2 * (x*z + y*w), sz * 2 * (y*z - x*w), sz * (1 - 2 * (x*x + y*y)), 0,
    tx, ty, tz, 1,
  ];
}

function multiply(parent, local) {
  return local.map((_, i) => {
    const row = i % 4;
    const start = i - row;
    return parent[row] * local[start] + parent[row + 4] * local[start + 1] +
      parent[row + 8] * local[start + 2] + parent[row + 12] * local[start + 3];
  });
}

function nodeList(indices) {
  if (indices === undefined) return [];
  if (!Array.isArray(indices)) invalid();
  return indices;
}

function sceneMeshes(json, visit) {
  const nodes = nodeList(json.nodes);
  let roots;
  if (json.scenes !== undefined) {
    const scene = objectAt(json.scenes, json.scene ?? 0);
    roots = nodeList(scene.nodes);
  } else if (nodes.length) {
    const nested = new Set(nodes.flatMap(node => nodeList(node?.children)));
    roots = nodes.map((_, index) => index).filter(index => !nested.has(index));
    if (!roots.length) invalid();
  } else {
    nodeList(json.meshes).forEach((_, index) => visit(index, identity));
    return;
  }

  const visited = new Set();
  const stack = roots.map(index => [index, identity]).reverse();
  while (stack.length) {
    const [index, parent] = stack.pop();
    if (visited.has(index)) invalid();
    visited.add(index);
    const node = objectAt(nodes, index);
    const matrix = multiply(parent, transform(node));
    if (node.mesh !== undefined) visit(node.mesh, matrix);
    const children = nodeList(node.children);
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], matrix]);
  }
}

function appendMesh(json, loadBuffer, mesh, matrix, vertices, faces) {
  if (!Array.isArray(mesh.primitives)) invalid();
  const offsets = new Map();
  for (const primitive of mesh.primitives) {
    const mode = nonnegative(primitive?.mode ?? 4);
    if (mode > 6) invalid();
    if (mode < 4) continue;
    if (primitive?.extensions?.KHR_draco_mesh_compression) throw Error('此 glTF 网格使用 Draco 压缩');
    const positionId = primitive?.attributes?.POSITION;
    const position = accessor(json, loadBuffer, positionId, 'VEC3');
    const index = primitive.indices === undefined ? null : accessor(json, loadBuffer, primitive.indices, 'SCALAR');
    const count = index ? index.count : position.count;
    if (count < 3 || (mode === 4 && count % 3)) invalid();
    const triangles = mode === 4 ? count / 3 : count - 2;
    if (faces.length + triangles > MAX_FACES) throw Error(MESH_LIMIT_ERROR);

    if (!offsets.has(positionId)) {
      if (vertices.length + position.count > MAX_VERTICES) throw Error(MESH_LIMIT_ERROR);
      offsets.set(positionId, vertices.length);
      for (let vertex = 0; vertex < position.count; vertex++) {
        const x = position.read(vertex, 0);
        const y = position.read(vertex, 1);
        const z = position.read(vertex, 2);
        const point = [0, 1, 2].map(axis => matrix[axis] * x + matrix[axis + 4] * y + matrix[axis + 8] * z + matrix[axis + 12]);
        if (!point.every(Number.isFinite)) invalid();
        vertices.push(point);
      }
    }
    const offset = offsets.get(positionId);
    const vertexIndex = row => {
      const value = index ? index.read(row) : row;
      if (value >= position.count) invalid();
      return offset + value;
    };
    for (let triangle = 0; triangle < triangles; triangle++) {
      const start = mode === 4 ? triangle * 3 : triangle;
      const face = [vertexIndex(mode === 6 ? 0 : start), vertexIndex(start + 1), vertexIndex(start + 2)];
      if (mode === 5 && triangle % 2) [face[0], face[1]] = [face[1], face[0]];
      faces.push(face);
    }
  }
}

export function parseGltf(bytes, format) {
  const {json, binary} = format === 'glb' ? readGlb(bytes) : {json: decodeJson(bytes)};
  if (typeof json?.asset?.version !== 'string' || !/^2\.\d+$/.test(json.asset.version)) invalid();
  const vertices = [];
  const faces = [];
  const loadBuffer = bufferReader(json, binary);
  sceneMeshes(json, (index, matrix) => {
    appendMesh(json, loadBuffer, objectAt(json.meshes, index), matrix, vertices, faces);
  });
  return {vertices, faces};
}
