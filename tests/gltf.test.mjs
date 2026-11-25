import assert from 'node:assert/strict';
import test from 'node:test';
import {parseGltf} from '../public/gltf.js';
import {MeshPreview} from '../public/preview.js';

const points = [[0, 0, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0]];
const triangles = [[0, 1, 2], [0, 2, 3]];

function fixture() {
  const binary = Buffer.alloc(70);
  for (const [row, point] of points.entries()) {
    for (const [axis, value] of point.entries()) binary.writeFloatLE(value, row * 16 + 4 + axis * 4);
  }
  binary.set(triangles.flat(), 64);
  const json = {
    asset: {version: '2.0'},
    buffers: [{byteLength: binary.length, uri: `data:application/octet-stream;base64,${binary.toString('base64')}`}],
    bufferViews: [{buffer: 0, byteLength: 64, byteStride: 16}, {buffer: 0, byteOffset: 64, byteLength: 6}],
    accessors: [
      {bufferView: 0, byteOffset: 4, componentType: 5126, count: 4, type: 'VEC3'},
      {bufferView: 1, componentType: 5121, count: 6, type: 'SCALAR'},
    ],
    meshes: [{primitives: [{attributes: {POSITION: 0}, indices: 1}]}],
    nodes: [{mesh: 0}],
    scenes: [{nodes: [0]}],
    scene: 0,
  };
  return {binary, json};
}

function chunk(bytes, type, pad) {
  const header = Buffer.alloc(8);
  const padding = Buffer.alloc((4 - bytes.length % 4) % 4, pad);
  header.writeUInt32LE(bytes.length + padding.length, 0);
  header.writeUInt32LE(type, 4);
  return Buffer.concat([header, bytes, padding]);
}

function makeGlb(json, binary) {
  delete json.buffers[0].uri;
  const chunks = [chunk(Buffer.from(JSON.stringify(json)), 0x4e4f534a, 0x20), chunk(binary, 0x004e4942, 0)];
  const header = Buffer.alloc(12);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + chunks.reduce((length, data) => length + data.length, 0), 8);
  return Buffer.concat([Buffer.alloc(3), header, ...chunks]).subarray(3);
}

test('GLB reads interleaved positions, typed indices and padded binary data', () => {
  const {binary, json} = fixture();
  const glb = makeGlb(json, binary);
  assert.deepEqual(parseGltf(glb, 'glb'), {vertices: points, faces: triangles});
  assert.throws(() => parseGltf(glb.subarray(0, -1), 'glb'), /数据不完整/);
});

test('embedded glTF uses the chosen scene and applies inherited TRS and mesh instancing', () => {
  const {json} = fixture();
  json.nodes = [
    {translation: [10, 20, 30], children: [1]},
    {mesh: 0, translation: [3, 4, 5], scale: [2, 3, 1], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2]},
    {mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, 0, 1, 1]},
    {mesh: 0, translation: [1000, 0, 0]},
  ];
  json.scenes = [{nodes: [3]}, {nodes: [0, 2]}];
  json.scene = 1;
  const mesh = parseGltf(Buffer.from(JSON.stringify(json)), 'gltf');
  assert.deepEqual(mesh.vertices.map(point => point.map(Math.round)), [
    [13, 24, 35], [13, 28, 35], [10, 28, 35], [10, 24, 35],
    [-2, 0, 1], [0, 0, 1], [0, 1, 1], [-2, 1, 1],
  ]);
  assert.deepEqual(mesh.faces, [...triangles, [4, 5, 6], [4, 6, 7]]);
});

test('non-indexed strips and fans reuse positions and preserve triangle winding', () => {
  const {json} = fixture();
  json.meshes[0].primitives = [
    {mode: 5, attributes: {POSITION: 0}}, {mode: 6, attributes: {POSITION: 0}},
  ];
  assert.deepEqual(parseGltf(Buffer.from(JSON.stringify(json)), 'gltf'), {
    vertices: points, faces: [[0, 1, 2], [2, 1, 3], ...triangles],
  });
});

test('glTF geometry rejects remote and relative buffers, cycles and invalid buffer bounds', () => {
  const {json} = fixture();
  const parse = () => parseGltf(Buffer.from(JSON.stringify(json)), 'gltf');
  const uri = json.buffers[0].uri;
  for (const path of ['mesh.bin', 'https://example.invalid/mesh.bin']) {
    json.buffers[0].uri = path;
    assert.throws(parse, /需要内嵌网格数据/);
  }
  json.buffers[0].uri = uri;
  json.nodes[0].children = [0];
  assert.throws(parse, /数据不完整/);
  delete json.nodes[0].children;
  json.accessors[0].count = 5;
  assert.throws(parse, /数据不完整/);
});

test('mesh renderer loads GLB and embedded glTF through the same base64 API', () => {
  const renderer = Object.create(MeshPreview.prototype);
  renderer.reset = () => {};
  const {binary, json} = fixture();
  assert.deepEqual(renderer.loadBinary(Buffer.from(JSON.stringify(json)).toString('base64'), 'gltf'), {vertices: 4, faces: 2});
  assert.deepEqual(renderer.loadBinary(makeGlb(json, binary).toString('base64'), 'GLB'), {vertices: 4, faces: 2});
  assert.throws(() => renderer.loadBinary('bad!', 'glb'), /glTF \/ GLB 文件格式无效/);
});
