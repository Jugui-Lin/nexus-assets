import assert from 'node:assert/strict';
import test from 'node:test';
import {applyTeamFolderVisibility, assetInFolder, buildFolderTree, filterFolderTree, findFolder, folderAncestors, relativeAssetPath, restoreLinkedTeamFolders} from '../public/folders.js';

test('explicit team relinks clear only local ancestor and exact exclusions', () => {
  const root = {libraryId: 'team', path: ''};
  const parent = {libraryId: 'team', path: 'Assets'};
  const selected = {libraryId: 'team', path: 'Assets/Plants'};
  const descendant = {libraryId: 'team', path: 'Assets/Plants/Draft'};
  const sibling = {libraryId: 'team', path: 'Assets/Plants Backup'};
  const other = {libraryId: 'other', path: ''};
  const rules = [root, parent, selected, descendant, sibling, other];
  const libraries = [{id: 'team', path: '\\\\nas\\Shared'}];
  assert.deepEqual(restoreLinkedTeamFolders(rules, [{libraryId:'team',folder:'assets/plants'}], libraries), [descendant, sibling, other]);
  assert.deepEqual(restoreLinkedTeamFolders(rules, [{libraryId:'team',folder:''}], libraries), [parent, selected, descendant, sibling, other]);
  assert.equal(restoreLinkedTeamFolders(rules, [{libraryId:'missing',folder:''}], libraries), rules);
});

test('team folders remain browsable before a member maps the shared drive', () => {
  const library = {id: 'studio', name: '设计共享库', source: 'team', path: null};
  const chair = {libraryId: 'studio', path: '', relativePath: '家具/客厅/椅子.obj'};
  const table = {libraryId: 'studio', path: '', relativePath: '家具/桌子.fbx'};
  const rootAsset = {libraryId: 'studio', path: '', relativePath: '说明.png'};
  const other = {libraryId: 'other', path: '', relativePath: '家具/灯.c4d'};
  const tree = buildFolderTree([chair, table, rootAsset, other], library);

  assert.equal(tree.count, 3);
  assert.equal(tree.directCount, 1);
  assert.equal(findFolder(tree, '').name, '设计共享库');
  assert.equal(findFolder(tree, '家具').count, 2);
  assert.equal(findFolder(tree, '家具').directCount, 1);
  assert.equal(findFolder(tree, '家具/客厅').directCount, 1);
  assert.deepEqual(folderAncestors('家具/客厅'), [
    {path: '家具', name: '家具'},
    {path: '家具/客厅', name: '客厅'},
  ]);
  assert.equal(assetInFolder(chair, library, '家具'), true);
  assert.equal(assetInFolder(chair, library, '家具', false), false);
  assert.equal(assetInFolder(table, library, '家具', false), true);
  assert.equal(assetInFolder(rootAsset, library, '', false), true);
  assert.equal(assetInFolder(other, library, '家具'), false);
});

test('Windows path components match case-insensitively without matching sibling roots', () => {
  const library = {id: 'local', path: 'D:\\Library\\', name: 'Library'};
  const top = {libraryId: 'local', path: 'd:/library/Design/model.obj'};
  const mixed = {libraryId: 'local', path: '\\\\?\\D:\\LIBRARY\\design\\Projects\\scene.blend'};
  const sibling = {libraryId: 'local', path: 'D:\\Library2\\Design\\outside.obj'};
  const tree = buildFolderTree([top, mixed, sibling], library);

  assert.equal(relativeAssetPath(top, library), 'Design/model.obj');
  assert.equal(relativeAssetPath(mixed, library), 'design/Projects/scene.blend');
  assert.equal(relativeAssetPath(sibling, library), null);
  assert.equal(tree.children.length, 1);
  assert.equal(findFolder(tree, 'DESIGN/projects').directCount, 1);
  assert.equal(assetInFolder(mixed, library, 'DESIGN'), true);
  assert.equal(assetInFolder(sibling, library, 'Design'), false);
});

test('UNC paths and macOS mounts use their own root and case conventions', () => {
  const unc = {id: 'nas', path: '\\\\server\\share\\Assets'};
  const file = {libraryId: 'nas', path: '\\\\?\\UNC\\SERVER\\SHARE\\assets\\材质\\白墙.png'};
  assert.equal(relativeAssetPath(file, unc), '材质/白墙.png');
  assert.equal(relativeAssetPath({...file, path: '//server/another/Assets/白墙.png'}, unc), null);

  const mac = {id: 'mac', path: '/Volumes/Shared/Assets'};
  const chair = {libraryId: 'mac', path: '/Volumes/Shared/Assets/Models/chair.obj'};
  assert.equal(assetInFolder(chair, mac, 'Models'), true);
  assert.equal(assetInFolder(chair, mac, 'models'), false);
  assert.equal(assetInFolder(chair, mac, 'Mod'), false);
  assert.equal(relativeAssetPath({...chair, path: '/Volumes/Shared/assets/Models/chair.obj'}, mac), null);
});

test('scanned folders preserve empty branches and merge their names with indexed files', () => {
  const library = {
    id: 'archive', name: '项目', path: 'D:/项目',
    folders: ['模型', '模型/未提交', '模型/未提交/草稿', 'models', '../escaped', '/absolute'],
  };
  const asset = {libraryId: 'archive', path: 'd:/项目/MODELS/椅子.obj'};
  const tree = buildFolderTree([asset], library);

  assert.deepEqual(tree.children.map(node => node.name).sort(), ['models', '模型']);
  assert.equal(findFolder(tree, 'MODELS').count, 1);
  assert.equal(findFolder(tree, '模型/未提交/草稿').count, 0);
  assert.equal(findFolder(tree, '模型/未提交').directCount, 0);
  assert.equal(assetInFolder(asset, library, '模型/未提交'), false);
});

test('a full personal scan replaces old directories without removing their asset records', () => {
  const library = {id: 'local', path: 'D:/资产', foldersComplete: true,
    folders: ['项目/归档', '新增/子文件夹']};
  const stale = {libraryId: 'local', path: 'D:/资产/项目/旧草稿/椅子.obj'};
  const moved = {libraryId: 'local', path: 'D:/资产/项目/归档/椅子.obj'};
  const added = {libraryId: 'local', path: 'D:/资产/新增/子文件夹/灯.obj'};
  const tree = buildFolderTree([stale, moved, added], library);

  assert.equal(findFolder(tree, '项目/旧草稿'), null);
  assert.equal(findFolder(tree, '项目/归档').directCount, 1);
  assert.equal(findFolder(tree, '新增/子文件夹').directCount, 1);
  assert.equal(findFolder(tree, '项目').count, 2);
  assert.equal(tree.count, 3);
  assert.equal(assetInFolder(stale, library), true);

  const legacy = {...library};
  delete legacy.foldersComplete;
  assert.equal(findFolder(buildFolderTree([stale], legacy), '项目/旧草稿').directCount, 1);
});

test('folder search retains ancestors and complete matching subtrees', () => {
  const library = {id: 'art', name: 'Archive', folders: ['props/chairs', 'props/desks', 'materials/chairs']};
  const assets = [{libraryId: 'art', relativePath: 'props/desks/walnut.obj'}];
  const tree = buildFolderTree(assets, library);
  const chairs = filterFolderTree(tree, ' CHAIRS ');
  assert.equal(chairs.count, 1);
  assert.equal(findFolder(chairs, 'props/desks'), null);
  assert.ok(findFolder(chairs, 'materials/chairs'));
  assert.equal(findFolder(filterFolderTree(tree, 'props'), 'props/desks').count, 1);
  assert.equal(filterFolderTree(tree, 'nonexistent'), null);
  assert.equal(filterFolderTree(tree, ''), tree);
});

test('team folder removals are local projections and restore from the full catalog', () => {
  const library = {id: 'team-lib', name: '团队共享库', source: 'team', path: null,
    folders: ['项目/模型/空文件夹', '项目/模型预览']};
  const second = {id: 'other', name: '其他团队库', source: 'team', path: null};
  const asset = (libraryId, relativePath) => ({libraryId, relativePath});
  const draft = asset(library.id, '项目/模型/草稿/椅子.obj');
  const model = asset(library.id, '项目/模型/桌子.obj');
  const preview = asset(library.id, '项目/模型预览/桌子.png');
  const other = asset(second.id, '项目/模型/窗户.obj');
  const catalog = {assets: [draft, model, preview, other], libraries: [library, second]};
  const nested = {libraryId: library.id, path: '项目/模型/草稿'};
  const parent = {libraryId: library.id, path: '项目/模型'};
  const root = {libraryId: library.id, path: ''};

  assert.deepEqual(applyTeamFolderVisibility(catalog, [root, parent, nested]), {assets: [other], libraries: [second]});
  const withoutParent = applyTeamFolderVisibility(catalog, [parent, nested]);
  assert.deepEqual(withoutParent.assets, [preview, other]);
  assert.equal(findFolder(buildFolderTree(withoutParent.assets, withoutParent.libraries[0]), parent.path), null);
  const withoutDraft = applyTeamFolderVisibility(catalog, [nested]);
  assert.deepEqual(withoutDraft.assets, [model, preview, other]);
  assert.equal(withoutDraft.assets[0], model);
  assert.equal(applyTeamFolderVisibility(catalog, []), catalog);
  assert.deepEqual(catalog.assets, [draft, model, preview, other]);
  assert.deepEqual(library.folders, ['项目/模型/空文件夹', '项目/模型预览']);

  const onlyDraft = {assets: [draft], libraries: [{...library, folders: []}]};
  const emptyParent = applyTeamFolderVisibility(onlyDraft, [nested]);
  assert.deepEqual(emptyParent.assets, []);
  assert.deepEqual(emptyParent.libraries[0].folders, ['项目', '项目/模型']);
});
