import assert from 'node:assert/strict';
import test from 'node:test';
import {buildCsvMetadataPlan, favoriteMarkdown, inventoryPath, parseAssetCsv, writeAssetCsv} from '../public/asset-inventory-format.js';

const first = {id:'a', name:'砂纸', path:'D:\\Project\\shot 1\\sand.png', tags:['磨砂'], notes:'旧备注', rating:2};
const second = {id:'b', name:'砂纸', path:'D:\\Other\\sand.png', tags:[], notes:'', rating:0};
const preferences = {mode:'id', matchColumn:0, fields:{tags:1,notes:2,rating:3}, assets:[first,second],
  externalIds:new Map(), root:'D:\\Project'};

test('CSV quoting preserves multiline comments, punctuation, formulas and existing apostrophes after explicit restoration', () => {
  const notes = ' =1+1\r\n需要 "引号"、逗号,或分号;';
  const file = writeAssetCsv(['id','tags','notes','rating'],[
    {id:'a',tags:'["磨砂","皮革,纹路"]',notes,rating:5},
    {id:'b',tags:'[]',notes:"'字面引号",rating:1},
  ],{separator:';'});
  assert.ok(file.startsWith('\ufeff'));
  const csv = parseAssetCsv(file);
  assert.equal(csv.records[0].values[2],"'" + notes);
  assert.equal(csv.records[1].values[2],"''字面引号");
  const plan = buildCsvMetadataPlan(csv,{...preferences,spreadsheetSafe:true});
  assert.equal(plan[0].line,2);
  assert.equal(plan[1].line,4);
  assert.deepEqual(plan[0].patch,{tags:['磨砂','皮革,纹路'],notes,rating:5});
  assert.equal(plan[1].patch.notes,"'字面引号");
});

test('import rejects ambiguous names and duplicate rows without replacing asset identities', () => {
  const named = parseAssetCsv('name,rating\r\n砂纸,5\r\n');
  assert.match(buildCsvMetadataPlan(named,{...preferences,mode:'name',fields:{rating:1}})[0].error,/多个资产/);
  const repeated = parseAssetCsv('id,rating\r\na,5\r\na,3\r\n');
  assert.ok(buildCsvMetadataPlan(repeated,{...preferences,fields:{rating:1}}).every(row => row.error.includes('多行')));
  assert.throws(() => parseAssetCsv('id,rating\r\na,"bad'),/引号没有闭合/);
  assert.throws(() => parseAssetCsv('id,rating\r\na,5,extra'),/列数超过表头/);
});

test('relative paths and external stable identifiers can be matched again, with outside-root safety and intentional blank updates', () => {
  assert.equal(inventoryPath(first,'d:\\PROJECT'),'shot 1/sand.png');
  assert.equal(inventoryPath(second,'D:\\Project'),'');
  const mapped = parseAssetCsv('path\texternal id\tnotes\r\nshot 1/sand.png\tEXT-123\t\r\n../Other/sand.png\tEXT-456\tno\r\n');
  const plan = buildCsvMetadataPlan(mapped,{...preferences,mode:'path',externalColumn:1,fields:{notes:2},clearEmpty:true});
  assert.equal(plan[0].asset.id,'a');
  assert.equal(plan[0].external,'EXT-123');
  assert.deepEqual(plan[0].patch,{notes:''});
  assert.match(plan[1].error,/未匹配/);
  const refreshed = parseAssetCsv('external id,rating\r\nEXT-123,5\r\n');
  assert.deepEqual(buildCsvMetadataPlan(refreshed,{...preferences,mode:'external',fields:{rating:1},
    externalIds:new Map([['EXT-123','a']])})[0].patch,{rating:5});
});

test('favorites use opt-in project-relative paths and escaped Markdown', () => {
  const unsafe = {...first,name:'[参考]<script>',notes:'打开 (文档)'};
  const plain = favoriteMarkdown([unsafe],{});
  assert.match(plain,/\\\[参考\\\]\\<script\\>/);
  assert.ok(!plain.includes('sand.png'));
  assert.ok(!plain.includes('文档'));
  const annotated = favoriteMarkdown([unsafe],{root:'D:\\Project',includePath:true,includeNotes:true});
  assert.ok(annotated.includes('shot 1/sand\\.png'));
  assert.ok(annotated.includes('打开 \\(文档\\)'));
});
