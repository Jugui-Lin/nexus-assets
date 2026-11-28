import assert from 'node:assert/strict';
import test from 'node:test';
import {groupExplorerRenderSequences,isExplorerRenderFrame} from '../public/local-explorer-render-sequences.js';

const entry = (path,options) => ({path,name:path.split(/[\\/]/).at(-1),isDirectory:false,...options});
const pathKey = path => /^(?:[a-z]:|[\\/]{2})/i.test(path)
  ? path.replaceAll('/','\\').replace(/\\+$/,'').toLowerCase()
  : path === '/' ? path : path.replace(/\/+$/,'');

test('groups PNG and EXR separately and keeps file identities and the list position', () => {
  const rows = [
    entry('D:/Renders/shot.0010.png',{size:240}),
    entry('D:/Renders/shot.0010.exr',{size:720}),
    entry('D:/Renders/notes.txt'),
    entry('D:/Renders/shot.0001.PNG',{size:310}),
    entry('D:/Renders/shot.0002.exr',{size:840}),
  ];
  const groups = groupExplorerRenderSequences(rows,pathKey);
  const png = groups.get(0);
  const exr = groups.get(1);
  assert.equal(groups.get(3),png);
  assert.equal(groups.get(4),exr);
  assert.notEqual(png.key,exr.key);
  assert.equal(groups.has(2),false);
  assert.equal(png.label,'shot.####.png');
  assert.equal(png.representativeIndex,0);
  assert.deepEqual([png.first,png.last],[1,10]);
  assert.deepEqual(png.frames.map(frame => [frame.index,frame.number,frame.entry]),[
    [3,1,rows[3]],
    [0,10,rows[0]],
  ]);
  assert.equal(png.frames[0].entry,rows[3]);
  assert.deepEqual(rows.map(row => row.name),['shot.0010.png','shot.0010.exr','notes.txt','shot.0001.PNG','shot.0002.exr']);
});

test('splits by directory, filename prefix and frame padding using platform path conventions', () => {
  const rows = [
    entry('D:/Renders/A/Shot_01.png'),
    entry('d:\\RENDERS\\a\\shot_02.PNG'),
    entry('D:/Renders/B/Shot_03.png'),
    entry('D:/Renders/A/Shot_3.png'),
    entry('D:/Renders/A/Shot_04.png',{isDirectory:true}),
    entry('/Volumes/Renders/A/Shot_01.png'),
    entry('/Volumes/Renders/A/shot_02.png'),
    entry('/Volumes/Renders/A/Shot_04.png'),
  ];
  const groups = groupExplorerRenderSequences(rows,pathKey);
  assert.deepEqual([...groups.keys()],[0,1,5,7]);
  assert.equal(groups.get(0),groups.get(1));
  assert.equal(groups.get(5),groups.get(7));
  assert.notEqual(groups.get(0).key,groups.get(5).key);
});

test('matches native frame name rules and keeps singletons ungrouped', () => {
  assert.equal(isExplorerRenderFrame('000001.v02.000001.exr'),true);
  assert.equal(isExplorerRenderFrame('001.tIFF'),true);
  assert.equal(isExplorerRenderFrame('frame.0000001.png'),false);
  assert.equal(isExplorerRenderFrame('frame.0001.c4d'),false);
  assert.equal(isExplorerRenderFrame('frame_0001\n.png'),false);
  assert.equal(isExplorerRenderFrame('frame_0001-preview.png'),false);
  assert.equal(isExplorerRenderFrame('ordinary.png'),false);
  const rows = [entry('D:/renders/shot_0001.png'),entry('D:/renders/shot_0001.exr')];
  assert.equal(groupExplorerRenderSequences(rows,pathKey).size,0);
});

test('stacks directly appended frame numbers without combining dates or formats', () => {
  const rows = [
    entry('D:/Renders/S04_11180031.exr'),
    entry('D:/Renders/S04_11180000.exr'),
    entry('D:/Renders/S04_11180002.exr'),
    entry('D:/Renders/S04_11190000.exr'),
    entry('D:/Renders/S04_11190001.exr'),
    entry('D:/Renders/S04_11180000.png'),
    entry('D:/Renders/S04_11180031.png'),
    entry('D:/Renders/S04_202611180003.exr'),
    entry('D:/Renders/S04_202611180004.exr'),
    entry('D:/Renders/S04_20261118.exr'),
    entry('D:/Renders/S04_20261119.exr'),
    entry('D:/Renders/S04_UDIM_1001.exr'),
    entry('D:/Renders/S04_UDIM_1002.exr'),
  ];
  const groups = groupExplorerRenderSequences(rows,pathKey);
  assert.equal(groups.size,9);
  assert.equal(groups.get(0).label,'S04_1118####.exr');
  assert.deepEqual(groups.get(0).frames.map(frame => frame.number),[0,2,31]);
  assert.equal(groups.get(3).label,'S04_1119####.exr');
  assert.equal(groups.get(5).label,'S04_1118####.png');
  assert.equal(groups.get(7).label,'S04_20261118####.exr');
  assert.equal(isExplorerRenderFrame('S04_13320001.exr'),false);
  assert.equal(isExplorerRenderFrame('S04_1001.exr'),true);
});
