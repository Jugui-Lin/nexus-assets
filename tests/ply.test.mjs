import assert from 'node:assert/strict';
import test from 'node:test';
import {parsePly} from '../public/ply.js';
import {MeshPreview} from '../public/preview.js';

const vertices = [[0, 0, 0], [2.5, 0, 0], [2.5, 1, 0], [0, 1, 0]];
const faces = [[0, 1, 2, 3]];

function asciiPly(data = ['4 0 1 2 3', '2 0.5 1.5', '0 0 0', '0 2.5 0', '1 2.5 0', '1 0 0']) {
  return Buffer.from([
    'ply', 'format ascii 1.0', 'comment property and element order vary by exporter',
    'element face 1', 'property list uchar int vertex_index',
    'element other 1', 'property list int16 float64 extras',
    'element vertex 4', 'property float y', 'property double x', 'property float32 z',
    'end_header', ...data, '',
  ].join('\r\n'));
}

function binaryPly(littleEndian, newline = '\n') {
  const header = Buffer.from([
    'ply', `format binary_${littleEndian ? 'little' : 'big'}_endian 1.0`, 'obj_info generated in test',
    'element vertex 4', 'property uchar red', 'property double x', 'property float y', 'property float z',
    'element face 1', 'property short texture', 'property list uint16 uint32 vertex_indices',
    'element edge 1', 'property int vertex1', 'property int vertex2', 'end_header', '',
  ].join(newline));
  const records = Buffer.alloc(96);
  const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
  let offset = 0;
  for (const [x, y, z] of vertices) {
    view.setUint8(offset, 10);
    view.setFloat64(offset + 1, x, littleEndian);
    view.setFloat32(offset + 9, y, littleEndian);
    view.setFloat32(offset + 13, z, littleEndian);
    offset += 17;
  }
  view.setInt16(offset, -1, littleEndian);
  view.setUint16(offset + 2, 4, littleEndian);
  for (const [index, value] of faces[0].entries()) {
    view.setUint32(offset + 4 + index * 4, value, littleEndian);
  }
  view.setInt32(offset + 20, 0, littleEndian);
  view.setInt32(offset + 24, 1, littleEndian);
  // The parser must respect a subarray's offset within its backing buffer.
  return Buffer.concat([Buffer.alloc(5), header, records, Buffer.alloc(3)]).subarray(5, -3);
}

test('ASCII PLY resolves vertices and faces in declared order and skips other fields', () => {
  assert.deepEqual(parsePly(asciiPly()), {vertices, faces});
});

test('binary PLY supports both byte orders and mixed scalar and list types', () => {
  assert.deepEqual(parsePly(binaryPly(true)), {vertices, faces});
  assert.deepEqual(parsePly(binaryPly(false, '\r\n')), {vertices, faces});
  // The first byte is 10, so the CR-only header must not consume it as part of CRLF.
  assert.deepEqual(parsePly(binaryPly(true, '\r')), {vertices, faces});
});

test('malformed PLY and excessive geometry fail with readable errors', () => {
  assert.throws(() => parsePly(binaryPly(true).subarray(0, -1)), /数据不完整/);
  assert.throws(() => parsePly(asciiPly(['4 0 1 2 4', '0', '0 0 0', '0 0 0', '0 0 0', '0 0 0'])), /数据不完整/);
  assert.throws(() => parsePly(asciiPly(['4 0 1 2 3', '0', '1e999 0 0', '0 0 0', '0 0 0', '0 0 0'])), /数据不完整/);
  assert.throws(() => parsePly(asciiPly(['4 0 1 2 3', '-5'])), /数据不完整/);
  assert.throws(() => parsePly(Buffer.from('ply\nformat ascii 1.0\nelement vertex 200001\nend_header\n')), /请使用简化代理/);
});

test('mesh renderer accepts PLY base64 and lets point clouds fall back to an image', () => {
  const renderer = Object.create(MeshPreview.prototype);
  renderer.reset = () => {};
  assert.deepEqual(renderer.loadBinary(asciiPly().toString('base64'), 'PLY'), {vertices: 4, faces: 1});
  assert.deepEqual(renderer.loadBinary(binaryPly(false).toString('base64'), 'ply'), {vertices: 4, faces: 1});
  assert.throws(() => renderer.loadBinary('invalid!', 'ply'), /PLY 文件格式无效/);
  const cloud = Buffer.from('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n1 2 3\n');
  assert.deepEqual(parsePly(cloud), {vertices: [[1, 2, 3]], faces: []});
  assert.throws(() => renderer.loadBinary(cloud.toString('base64'), 'ply'), /未找到由面组成的网格/);
});
