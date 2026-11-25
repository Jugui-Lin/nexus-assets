export const MAX_VERTICES = 200_000;
export const MAX_FACES = 100_000;
export const MESH_LIMIT_ERROR = '模型面数过多，请使用简化代理或预览图';

const STL_HEADER_BYTES = 84;
const STL_TRIANGLE_BYTES = 50;
const MAX_STL_TRIANGLES = Math.min(MAX_FACES, Math.floor(MAX_VERTICES / 3));
const STL_FORMAT_ERROR = 'STL 文件格式无效或数据不完整';

function addTriangle(vertices, faces, triangle) {
  if (faces.length >= MAX_STL_TRIANGLES) throw Error(MESH_LIMIT_ERROR);
  if (!triangle.every(vertex => vertex.every(Number.isFinite))) throw Error(STL_FORMAT_ERROR);
  const first = vertices.length;
  vertices.push(...triangle);
  faces.push([first, first + 1, first + 2]);
}

function parseBinaryStl(view, count) {
  if (count > MAX_STL_TRIANGLES) throw Error(MESH_LIMIT_ERROR);
  const vertices = [];
  const faces = [];
  for (let offset = STL_HEADER_BYTES; offset < view.byteLength; offset += STL_TRIANGLE_BYTES) {
    const triangle = [];
    for (let vertexOffset = offset + 12; vertexOffset < offset + 48; vertexOffset += 12) {
      triangle.push([
        view.getFloat32(vertexOffset, true),
        view.getFloat32(vertexOffset + 4, true),
        view.getFloat32(vertexOffset + 8, true),
      ]);
    }
    addTriangle(vertices, faces, triangle);
  }
  return { vertices, faces };
}

function parseAsciiStl(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw Error(STL_FORMAT_ERROR);
  }
  // Remove named solid boundaries and allow arbitrary whitespace between geometry tokens.
  const lines = text.split(/\r\n?|\n/);
  const vertices = [];
  const faces = [];
  let insideSolid = false;
  let facetLines = [];
  const number = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
  const words = /\S+/g;

  function parseFacets(source) {
    const tokens = source.matchAll(words);
    const next = () => tokens.next().value?.[0];
    const expect = expected => {
      if (next()?.toLowerCase() !== expected) throw Error(STL_FORMAT_ERROR);
    };
    const coordinate = () => {
      const raw = next();
      if (!raw || !number.test(raw)) throw Error(STL_FORMAT_ERROR);
      const result = Number(raw);
      if (!Number.isFinite(result)) throw Error(STL_FORMAT_ERROR);
      return result;
    };
    for (let start = next(); start !== undefined; start = next()) {
      if (start.toLowerCase() !== 'facet') throw Error(STL_FORMAT_ERROR);
      expect('normal');
      coordinate();
      coordinate();
      coordinate();
      expect('outer');
      expect('loop');
      const triangle = [];
      for (let vertex = 0; vertex < 3; vertex++) {
        expect('vertex');
        triangle.push([coordinate(), coordinate(), coordinate()]);
      }
      expect('endloop');
      expect('endfacet');
      addTriangle(vertices, faces, triangle);
    }
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^solid(?:\s|$)/i.test(line) && !insideSolid) {
      insideSolid = true;
    } else if (/^endsolid(?:\s|$)/i.test(line) && insideSolid) {
      parseFacets(facetLines.join('\n'));
      facetLines = [];
      insideSolid = false;
    } else if (insideSolid) {
      facetLines.push(line);
    } else {
      throw Error(STL_FORMAT_ERROR);
    }
  }
  if (insideSolid) throw Error(STL_FORMAT_ERROR);
  return { vertices, faces };
}

export function parseStl(bytes) {
  if (bytes.byteLength >= STL_HEADER_BYTES) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    // Some binary exporters put "solid" in the header, so trust the exact record layout first.
    if (STL_HEADER_BYTES + count * STL_TRIANGLE_BYTES === bytes.byteLength) {
      return parseBinaryStl(view, count);
    }
  }
  return parseAsciiStl(bytes);
}
