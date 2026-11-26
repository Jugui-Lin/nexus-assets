import {matchFolderAddress} from './folder-address.js';

const maxRows = 5001;
const maxColumns = 100;
const unsafeCell = /^[\u0000-\u0020\ufeff]*[=+\-@\uff1d\uff0b\uff0d\uff20]/;
export const inventoryFields = {
  id:'资产编号', name:'名称', format:'格式', path:'原件路径', tags:'标签', notes:'备注', rating:'评分',
};

function delimiterOf(text) {
  const hits = new Map([[',',0],['\t',0],[';',0]]);
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === '\r' || char === '\n') break;
    if (hits.has(char)) hits.set(char,hits.get(char) + 1);
  }
  return [...hits].reduce((best,item) => item[1] > best[1] ? item : best)[0];
}

export function parseAssetCsv(content) {
  const text = content.replace(/^\ufeff/,'');
  const delimiter = delimiterOf(text);
  const records = [];
  let row = [], cell = '', quoted = false, closed = false, line = 1, startLine = 1;
  function pushCell() {
    if (row.length >= maxColumns) throw Error('表格最多可有 100 列。');
    row.push(cell);
    cell = '';
    closed = false;
  }
  function pushRow() {
    pushCell();
    if (row.some(value => value !== '')) records.push({line:startLine,values:row});
    if (records.length > maxRows) throw Error('一次最多预览 5,000 行数据。');
    row = [];
    startLine = line + 1;
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') {
      cell += '"';
      index++;
    } else if (quoted && char === '"') {
      quoted = false;
      closed = true;
    } else if (quoted) {
      cell += char;
      if (char === '\n' || char === '\r' && text[index + 1] !== '\n') line++;
    } else if (char === delimiter) {
      pushCell();
    } else if (char === '\n' || char === '\r') {
      pushRow();
      if (char === '\r' && text[index + 1] === '\n') index++;
      line++;
    } else if (closed) {
      throw Error('第 ' + line + ' 行的引号后应直接跟分隔符或换行。');
    } else if (char === '"') {
      if (cell.length) throw Error('第 ' + line + ' 行包含未转义的引号。');
      quoted = true;
    } else cell += char;
  }
  if (quoted) throw Error('第 ' + startLine + ' 行的引号没有闭合。');
  if (row.length || cell.length || closed) pushRow();
  const header = records.shift()?.values;
  if (!header?.some(value => value.trim()) || !records.length) throw Error('请选择包含表头和至少一行数据的表格。');
  const long = records.find(record => record.values.length > header.length);
  if (long) throw Error('第 ' + long.line + ' 行的列数超过表头，请核对分隔符和引号。');
  return {header,records};
}

function escapeCell(raw,spreadsheetSafe) {
  let value = String(raw ?? '');
  if (spreadsheetSafe && (unsafeCell.test(value) || value.startsWith("'"))) value = "'" + value;
  return '"' + value.replaceAll('"','""') + '"';
}

function readCell(value,spreadsheetSafe) {
  if (!spreadsheetSafe || !value?.startsWith("'")) return value ?? '';
  const rest = value.slice(1);
  return rest.startsWith("'") || unsafeCell.test(rest) ? rest : value;
}

export function writeAssetCsv(fields,rows,{separator = ',',spreadsheetSafe = true} = {}) {
  return '\ufeff' + [fields.map(field => inventoryFields[field]),...rows.map(row => fields.map(field => row[field]))]
    .map(row => row.map(value => escapeCell(value,spreadsheetSafe)).join(separator)).join('\r\n') + '\r\n';
}

export function pathIdentity(path) {
  const value = matchFolderAddress(path,[])?.path;
  return !value ? '' : /^(?:[a-z]:|\\\\)/i.test(value) ? value.toLowerCase() : value;
}

export function inventoryPath(asset,root) {
  if (!root) return asset.path || '';
  return matchFolderAddress(asset.path,[{id:'project',path:root}])?.match?.folder || '';
}

function matchedPath(path,root) {
  const absolute = pathIdentity(path);
  if (absolute || !root || /^[a-z]:|^[/\\]/i.test(path)) return absolute;
  if (path.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) return '';
  return pathIdentity(root.replace(/[/\\]$/,'') + '/' + path);
}

function normalizeTags(value) {
  let items;
  if (value.trimStart().startsWith('[')) {
    try { items = JSON.parse(value); } catch { throw Error('标签数组不是有效的 JSON。'); }
    if (!Array.isArray(items) || items.some(tag => typeof tag !== 'string')) throw Error('标签数组必须由文字组成。');
  } else items = value.split(/[,，;；\n]/);
  const tags = [...new Set(items.map(tag => tag.trim()).filter(Boolean))];
  if (tags.length > 30 || tags.some(tag => Array.from(tag).length > 40 || /[\u0000-\u001f\u007f]/.test(tag))) {
    throw Error('每项资产最多 30 个标签，每个标签最多 40 个字符且应为单行。');
  }
  return tags;
}

function addMatch(map,key,asset) {
  if (!key) return;
  if (map.has(key)) map.set(key,null);
  else map.set(key,asset);
}

export function buildCsvMetadataPlan(csv,{mode,matchColumn,externalColumn,fields,assets,externalIds,root,clearEmpty,spreadsheetSafe}) {
  const index = new Map();
  const byId = new Map(assets.map(asset => [asset.id,asset]));
  if (mode === 'external') {
    for (const [key,id] of externalIds) if (byId.has(id)) index.set(key,byId.get(id));
  } else {
    for (const asset of assets) addMatch(index,mode === 'path' ? pathIdentity(asset.path) : String(asset[mode] || '').trim(),asset);
  }
  const ids = new Map();
  const assigned = new Map();
  for (const row of csv.records) {
    row.error = '';
    row.asset = null;
    row.patch = null;
    row.external = '';
    const read = column => readCell(row.values[column],spreadsheetSafe);
    const value = read(matchColumn).trim();
    const key = mode === 'path' ? matchedPath(value,root) : value;
    const asset = key && index.get(key);
    row.reference = value;
    row.asset = asset || null;
    if (!asset) {
      row.error = key && index.has(key) ? '匹配到多个资产，请改用资产编号。' : '未匹配到当前库的资产。';
      continue;
    }
    const previous = ids.get(asset.id);
    if (previous) {
      previous.error = row.error = '多行指向同一资产，请保留一行。';
      continue;
    }
    ids.set(asset.id,row);
    try {
      if (Number.isInteger(externalColumn)) {
        const external = read(externalColumn).trim();
        const assignedId = externalIds.get(external);
        if (external.length > 200 || /[\u0000-\u001f\u007f]/.test(external)) throw Error('外部编号应为不超过 200 个字符的单行文字。');
        if (assignedId && assignedId !== asset.id) throw Error('此外部编号已关联另一项资产。');
        if (external && assigned.has(external)) {
          assigned.get(external).error = '多项资产使用同一个外部编号。';
          throw Error('多项资产使用同一个外部编号。');
        }
        if (external) assigned.set(external,row);
        row.external = external;
      }
      const patch = {};
      for (const [field,column] of Object.entries(fields)) {
        if (!Number.isInteger(column) || column >= row.values.length) continue;
        const raw = read(column);
        if (!raw.trim() && !clearEmpty) continue;
        let parsed;
        if (field === 'tags') parsed = normalizeTags(raw);
        else if (field === 'rating') {
          if (raw.trim() && !/^[0-5]$/.test(raw.trim())) throw Error('评分应为 0–5 的整数。');
          parsed = Number(raw.trim());
        } else {
          if (Array.from(raw).length > 10000 || raw.includes('\0')) throw Error('备注不能包含空字符，也不能超过 10,000 字。');
          parsed = raw;
        }
        if (JSON.stringify(asset[field]) !== JSON.stringify(parsed)) patch[field] = parsed;
      }
      if (!Object.keys(patch).length && (!row.external || row.external && externalIds.get(row.external) === asset.id)) {
        throw Error('所选字段与现有资料相同。');
      }
      row.patch = patch;
    } catch (error) { row.error = error.message; }
  }
  return csv.records;
}

export function favoriteMarkdown(assets,{root,includePath,includeNotes}) {
  const safe = value => String(value ?? '').replace(/[\r\n]+/g,' ').replace(/[\\`*_{}\[\]()#+.!|<>]/g,'\\$&');
  return '# 资产收藏\n\n' + assets.map(asset => {
    let line = '- ' + safe(asset.name);
    const path = includePath && inventoryPath(asset,root);
    if (path) line += '\n  - ' + safe(path);
    if (includeNotes && asset.notes) line += '\n  - ' + safe(asset.notes);
    return line;
  }).join('\n') + '\n';
}
