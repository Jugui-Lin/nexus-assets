import {MAX_FACES, MAX_VERTICES, MESH_LIMIT_ERROR} from './mesh-formats.js';

export const PLY_FORMAT_ERROR = 'PLY 文件格式无效或数据不完整';

const maxHeaderBytes = 64 * 1024;
const maxFaceIndices = MAX_FACES * 6;
const formats = new Set(['ascii', 'binary_little_endian', 'binary_big_endian']);
const coordinates = new Map([['x', 0], ['y', 1], ['z', 2]]);
const indexNames = new Set(['vertex_index', 'vertex_indices']);
const integerToken = /^[+-]?\d+$/;
const numberToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const scalarTypes = new Map();
for (const [names, getter, size, min, max] of [
  ['char int8', 'getInt8', 1, -128, 127],
  ['uchar uint8', 'getUint8', 1, 0, 255],
  ['short int16', 'getInt16', 2, -32768, 32767],
  ['ushort uint16', 'getUint16', 2, 0, 65535],
  ['int int32', 'getInt32', 4, -2147483648, 2147483647],
  ['uint uint32', 'getUint32', 4, 0, 4294967295],
  ['float float32', 'getFloat32', 4],
  ['double float64', 'getFloat64', 8],
]) {
  const type = {getter, size, min, max, integer: min !== undefined};
  for (const name of names.split(' ')) scalarTypes.set(name, type);
}

function invalid() {
  throw Error(PLY_FORMAT_ERROR);
}

function readHeader(bytes) {
  const decoder = new TextDecoder();
  const limit = Math.min(bytes.byteLength, maxHeaderBytes);
  let offset = 0;
  let crOnly = false;

  function line(first = false) {
    const start = offset;
    while (offset < limit && bytes[offset] !== 10 && bytes[offset] !== 13) offset++;
    if (offset === limit) invalid();
    const end = offset++;
    if (first) crOnly = bytes[end] === 13 && bytes[offset] !== 10;
    if (!crOnly && bytes[end] === 13 && bytes[offset] === 10) offset++;
    return decoder.decode(bytes.subarray(start, end)).trim();
  }

  if (line(true) !== 'ply') invalid();
  const [formatKeyword, format, version, ...extra] = line().split(/\s+/);
  if (formatKeyword !== 'format' || !formats.has(format) || version !== '1.0' || extra.length) invalid();

  const elements = new Map();
  let element;
  for (;;) {
    const [keyword, ...args] = line().split(/\s+/);
    if (keyword === 'end_header' && !args.length) break;
    if (!keyword || keyword === 'comment' || keyword === 'obj_info') continue;
    if (keyword === 'element') {
      const [name, countToken] = args;
      const count = Number(countToken);
      if (args.length !== 2 || !/^\d+$/.test(countToken) || !Number.isSafeInteger(count) || elements.has(name)) invalid();
      const max = name === 'vertex' ? MAX_VERTICES : name === 'face' ? MAX_FACES : Infinity;
      if (count > max) throw Error(MESH_LIMIT_ERROR);
      element = {name, count, properties: new Map()};
      elements.set(name, element);
      continue;
    }
    if (keyword !== 'property' || !element) invalid();
    const property = parseProperty(args);
    if (element.properties.has(property.name)) invalid();
    element.properties.set(property.name, property);
  }

  const vertex = elements.get('vertex');
  if (!vertex) invalid();
  for (const name of coordinates.keys()) {
    const property = vertex.properties.get(name);
    if (!property || property.countType) invalid();
  }
  const face = elements.get('face');
  const faceIndices = face && [...face.properties.values()].find(property =>
    indexNames.has(property.name) && property.countType && property.type.integer
  );
  if (face?.count && !faceIndices) invalid();
  return {format, offset, elements, vertexCount: vertex.count, faceIndices};
}

function parseProperty(args) {
  if (args[0] === 'list') {
    const [, countName, typeName, name] = args;
    const countType = scalarTypes.get(countName);
    const type = scalarTypes.get(typeName);
    if (args.length !== 4 || !countType?.integer || !type) invalid();
    return {name, type, countType};
  }
  const [typeName, name] = args;
  const type = scalarTypes.get(typeName);
  if (args.length !== 2 || !type) invalid();
  return {name, type};
}

function asciiReader(bytes) {
  const text = new TextDecoder().decode(bytes);
  const word = /\S+/g;
  function read(type) {
    const token = word.exec(text)?.[0];
    if (!token || !(type.integer ? integerToken : numberToken).test(token)) invalid();
    const value = Number(token);
    if (type.integer && (value < type.min || value > type.max)) invalid();
    const converted = !type.integer && type.size === 4 ? Math.fround(value) : value;
    if (!Number.isFinite(converted)) invalid();
    return converted;
  }
  return {
    read,
    checkList: count => { if (count > text.length - word.lastIndex) invalid(); },
    skip: count => { for (let i = 0; i < count; i++) if (!word.exec(text)) invalid(); },
    finish: () => { if (word.test(text)) invalid(); },
  };
}

function binaryReader(bytes, littleEndian) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  function checkList(count, type) {
    if (count * type.size > view.byteLength - offset) invalid();
  }
  return {
    read(type) {
      checkList(1, type);
      const value = view[type.getter](offset, littleEndian);
      offset += type.size;
      return value;
    },
    checkList,
    skip: (count, type) => { offset += count * type.size; },
    finish: () => { if (offset !== view.byteLength) invalid(); },
  };
}

export function parsePly(bytes) {
  const {format, offset, elements, vertexCount, faceIndices} = readHeader(bytes);
  const body = bytes.subarray(offset);
  const reader = format === 'ascii' ? asciiReader(body) : binaryReader(body, format === 'binary_little_endian');
  const vertices = [];
  const faces = [];
  let totalIndices = 0;

  for (const {name, count, properties} of elements.values()) {
    if (!properties.size) continue;
    for (let row = 0; row < count; row++) {
      const vertex = name === 'vertex' ? new Array(3) : null;
      for (const property of properties.values()) {
        const {type, countType} = property;
        if (countType) {
          const size = reader.read(countType);
          if (size < 0) invalid();
          reader.checkList(size, type);
          if (property !== faceIndices) {
            reader.skip(size, type);
            continue;
          }
          if (size < 3) invalid();
          totalIndices += size;
          if (totalIndices > maxFaceIndices) throw Error(MESH_LIMIT_ERROR);
          const face = [];
          for (let i = 0; i < size; i++) {
            const index = reader.read(type);
            if (index < 0 || index >= vertexCount) invalid();
            face.push(index);
          }
          faces.push(face);
        } else if (vertex && coordinates.has(property.name)) {
          const value = reader.read(type);
          if (!Number.isFinite(value)) invalid();
          vertex[coordinates.get(property.name)] = value;
        } else {
          reader.checkList(1, type);
          reader.skip(1, type);
        }
      }
      if (vertex) vertices.push(vertex);
    }
  }
  reader.finish();
  return {vertices, faces};
}
