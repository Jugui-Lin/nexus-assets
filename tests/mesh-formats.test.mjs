import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStl } from '../public/mesh-formats.js';
import { MeshPreview } from '../public/preview.js';

function binaryStl() {
  const enclosing = Buffer.alloc(142);
  const mesh = enclosing.subarray(4, 138);
  mesh.write('solid binary header', 'ascii');
  mesh.writeUInt32LE(1, 80);
  for (const [index, value] of [0, 0, 0, 2.5, 0, 0, 0, 0, 1].entries()) {
    mesh.writeFloatLE(value, 96 + index * 4);
  }
  mesh.writeUInt16LE(0x8000, 132);
  return mesh;
}

test('binary STL accepts solid headers, colors and byte offsets', () => {
  assert.deepEqual(parseStl(binaryStl()), {
    vertices: [[0, 0, 0], [2.5, 0, 0], [0, 0, 1]],
    faces: [[0, 1, 2]],
  });
});

test('ASCII STL accepts names, exponent notation and multiple solids', () => {
  const encoder = new TextEncoder();
  const oneFacet = '  FACET normal 0 0 1\r\n    outer loop\r\n      vertex 0 0 0\r\n      vertex 25e-1 0 0\r\n      vertex 0 0 +.1E1\r\n    endloop\r\n  endfacet\r\n';
  const text = `\ufeffsolid model a\r\n${oneFacet}endsolid model a\r\nsolid second\r\n${oneFacet}endsolid second\r\n`;
  const { vertices, faces } = parseStl(encoder.encode(text));
  assert.deepEqual(vertices, [[0, 0, 0], [2.5, 0, 0], [0, 0, 1], [0, 0, 0], [2.5, 0, 0], [0, 0, 1]]);
  assert.deepEqual(faces, [[0, 1, 2], [3, 4, 5]]);
});

test('invalid topology, non-finite coordinates and short binary records fail cleanly', () => {
  const data = binaryStl();
  assert.throws(() => parseStl(data.subarray(0, -1)), /数据不完整/);
  data.writeFloatLE(Infinity, 100);
  assert.throws(() => parseStl(data), /数据不完整/);
  assert.throws(() => parseStl(new TextEncoder().encode('solid a\nfacet normal 0 0 1 outer loop vertex 0 0 0 endloop endfacet\nendsolid a')), /数据不完整/);
});

test('renderer loads STL and retains support for OBJ with inline comments', () => {
  const renderer = Object.create(MeshPreview.prototype);
  renderer.reset = () => {};
  assert.deepEqual(renderer.loadBinary(binaryStl().toString('base64'), 'STL'), { vertices: 3, faces: 1 });
  assert.ok(renderer.vertices[2][1] > renderer.vertices[0][1]);
  assert.match(renderer.faces[0].fill, /^rgb\(/);
  assert.deepEqual(renderer.load('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1 # test'), { vertices: 3, faces: 1 });
  assert.throws(() => renderer.loadBinary('bad!', 'stl'), /数据不完整/);
});
