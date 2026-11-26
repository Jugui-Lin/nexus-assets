import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {promisify} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';

const exec = promisify(execFile);
const defaultBinary = process.platform === 'win32' ? 'nexus-team.exe' : 'nexus-team';
const binary = path.resolve(process.env.NEXUS_TEAM_BINARY ?? path.join('src-tauri', 'target', 'release', defaultBinary));

async function startTeamServer(database, ...flags) {
  return startConfiguredTeamServer(database, {}, ...flags);
}

async function startConfiguredTeamServer(database, environment, ...flags) {
  const server = spawn(binary, ['--data', database, 'serve', '127.0.0.1:0', ...flags], {
    windowsHide: true,
    env: {...process.env, ...environment},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const address = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Team server did not start')), 7000);
      let stdout = '';
      server.stdout.on('data', chunk => {
        stdout += chunk.toString();
        const address = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (address) { clearTimeout(timeout); resolve(address); }
      });
      server.on('error', e => { clearTimeout(timeout); reject(e); });
      server.on('exit', code => { clearTimeout(timeout); reject(Error('Team server exited with code ' + code)); });
    });
    return {server, address};
  } catch (error) {
    await stopTeamServer(server);
    throw error;
  }
}

async function stopTeamServer(server) {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null) return;
  const closed = new Promise(resolve => server.once('close', resolve));
  server.kill();
  await closed;
}

function teamRequest(address) {
  return async (method, route, identity, body, headers = {}) => {
    const requestHeaders = {'content-type': 'application/json', ...headers};
    if (identity) requestHeaders.authorization = 'Bearer ' + identity.token;
    const response = await fetch(address + '/v1/' + route, {
      method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    const type = response.headers.get('content-type');
    const json = type?.includes('application/json') ? await response.json() : null;
    return {status: response.status, json};
  };
}

function credentials(output) {
  const token = output.match(/[a-f0-9]{64}/)?.[0];
  if (!token) throw new Error('Member credentials were not produced');
  return {token, id: output.match(/[a-f0-9-]{36}/)?.[0]};
}

test('team whiteboard merges peer edits, validates batches atomically and survives restart', {timeout: 25_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-whiteboard-test-'));
  const database = path.join(scratch, 'db');
  const cli = async (...args) => (await exec(binary, ['--data', database, ...args], {windowsHide:true})).stdout;
  let server;
  try {
    const admin = credentials(await cli('init', '白板协作', '管理员'));
    const member = credentials(await cli('member-add', '成员'));
    let running = await startTeamServer(database);
    server = running.server;
    let request = teamRequest(running.address);
    const read = identity => request('GET', 'whiteboard', identity);
    const post = (identity, operations, batchId) => request('POST', 'whiteboard', identity, {operations, batchId});
    assert.equal((await read()).status, 401);
    assert.equal((await post(null, [])).status, 401);
    assert.deepEqual((await read(member)).json, {revision:0, items:[]});

    const note = randomUUID();
    const notePatch = {kind:'note', x:32.25, y:-6.5, width:210, height:145, text:'第一稿', color:'mint'};
    const create = [{id:note, patch:notePatch}];
    const batchId = randomUUID();
    assert.deepEqual((await post(member, create, batchId)).json, {
      revision:1, items:[{id:note, ...notePatch, points:[]}],
    });
    const [moved, renamed] = await Promise.all([
      post(admin, [{id:note, patch:{x:105.5}}]),
      post(member, [{id:note, patch:{text:'第二稿\n批注'}}]),
    ]);
    assert.equal(moved.status, 200);
    assert.equal(renamed.status, 200);
    const merged = {revision:3, items:[{id:note, ...notePatch, x:105.5, text:'第二稿\n批注', points:[]}]};
    assert.deepEqual((await read(admin)).json, merged);
    assert.deepEqual((await post(member, create, batchId)).json, merged);
    assert.equal((await post(member, [{id:note, patch:{y:50}}], batchId)).status, 409);

    const stroke = randomUUID();
    const strokePatch = {kind:'stroke', x:12, y:14, width:31, height:1, points:[[0, 0], [31, 0.5]]};
    assert.equal((await post(member, [{id:stroke, patch:strokePatch}, {id:note, patch:{width:0}}])).status, 400);
    assert.deepEqual((await read(admin)).json, merged);
    assert.equal((await post(member, [{id:stroke, patch:{...strokePatch, points:Array.from({length:1_025}, () => [0, 0])}}])).status, 400);
    const saved = await post(member, [{id:stroke, patch:strokePatch}, {id:note, delete:true}]);
    assert.deepEqual(saved.json, {revision:4, items:[{id:stroke, ...strokePatch, color:'slate', text:''}]});
    assert.deepEqual((await post(admin, [{id:note, patch:{text:'已删除'}}])).json, saved.json);
    assert.deepEqual((await post(admin, create)).json, saved.json);
    assert.equal((await post(admin, [{id:stroke, patch:{text:'x'.repeat(8_193)}}])).status, 400);
    assert.equal((await post(admin, [{id:stroke, patch:{text:'x'.repeat(512 * 1024)}}])).status, 413);
    assert.equal((await post(admin, Array.from({length:65}, () => ({id:stroke, delete:true})))).status, 400);

    await stopTeamServer(server);
    running = await startTeamServer(database);
    server = running.server;
    request = teamRequest(running.address);
    assert.deepEqual((await read(admin)).json, saved.json);
    assert.deepEqual((await post(member, create, batchId)).json, saved.json);
    await cli('member-disable', member.id);
    assert.equal((await post(member, [{id:stroke, delete:true}])).status, 401);

    const secondDatabase = path.join(scratch, 'other-team');
    const other = credentials((await exec(binary, ['--data', secondDatabase, 'init', '另一个团队', '管理员'], {windowsHide:true})).stdout);
    const second = await startTeamServer(secondDatabase);
    try {
      const otherRequest = teamRequest(second.address);
      assert.deepEqual((await otherRequest('GET', 'whiteboard', other)).json, {revision:0, items:[]});
      assert.equal((await otherRequest('GET', 'whiteboard', admin)).status, 401);
    } finally {
      await stopTeamServer(second.server);
    }
  } finally {
    await stopTeamServer(server);
    await fs.rm(scratch, {recursive:true, force:true});
  }
});

test('team whiteboard validates image blobs, synchronizes references and keeps older clients readable', {timeout: 25_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-whiteboard-images-'));
  const database = path.join(scratch, 'db');
  const cli = async (...args) => (await exec(binary, ['--data', database, ...args], {windowsHide:true})).stdout;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAAxElEQVR4nO3RMREAIBDAsFeCOtRhEmQwNEP33mXW2Vf/mt8D9QAAaAcAQDsAANoBANAOAIB2AAC0AwCgHQAA7QAAaAcAQDsAANoBANAOAIB2AAC0AwCgHQAA7QAAaAcAQDsAANoBANAOAIB2AAC0AwCgHQAA7QAAaAcAQDsAANoBANAOAIB2AAC0AwCgHQAA7QAAaAcAQDsAANoBANAOAIB2AAC0AwCgHQAA7QAAaAcAQDsAANoBANAOAIB2AAC0AwCg3QN1XhCTyEPk1wAAAABJRU5ErkJggg==';
  const pngImage = {mime:'image/png', base64:png};
  const digest = base64 => createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
  const imageId = digest(png);
  const imageRoute = id => 'whiteboard-images/' + id;
  const extendedBoard = 'whiteboard?extended=1';
  const referenceBoard = `${extendedBoard}&assetReferences=1`;
  let server;
  try {
    const admin = credentials(await cli('init', '白板图片', '管理员'));
    const member = credentials(await cli('member-add', '成员'));
    let running = await startTeamServer(database);
    server = running.server;
    let request = teamRequest(running.address);
    const put = (id, data = pngImage, owner = member) => request('PUT', imageRoute(id), owner, data);
    const read = (identity, route = extendedBoard) => request('GET', route, identity);
    const post = (identity, operations, route = extendedBoard) => request('POST', route, identity, {operations});

    assert.equal((await put(imageId, pngImage, null)).status, 401);
    assert.equal((await read(null, imageRoute(imageId))).status, 401);
    assert.equal((await read(member, imageRoute(imageId))).status, 404);
    const asset = {id:randomUUID(), patch:{kind:'image', x:32, y:4, width:96, height:96, text:'参考图', imageId}};
    assert.equal((await post(member, [asset])).status, 404);
    assert.equal((await put(imageId.toUpperCase())).status, 400);
    assert.equal((await put('0'.repeat(64))).status, 400);
    assert.equal((await put(imageId, {...pngImage, mime:'image/jpeg'})).status, 400);
    const invalid = Buffer.from('invalid image bytes').toString('base64');
    assert.equal((await put(digest(invalid), {mime:'image/png', base64:invalid})).status, 400);

    assert.deepEqual(await put(imageId), {status:200, json:{imageId}});
    assert.deepEqual(await put(imageId), {status:200, json:{imageId}});
    assert.deepEqual(await read(admin, imageRoute(imageId)), {status:200, json:pngImage});
    const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    assert.deepEqual(await put(digest(gif), {mime:'image/gif', base64:gif}), {status:200, json:{imageId:digest(gif)}});

    const note = {id:randomUUID(), patch:{kind:'note', x:4, y:12, width:92, height:42, text:'兼容'}};
    const arrow = {id:randomUUID(), patch:{kind:'arrow', x:0, y:12, width:32, height:42, points:[[0, 0], [32, 42]]}};
    const frame = {id:randomUUID(), patch:{kind:'frame', x:10, y:10, width:220, height:180, text:'资料'}};
    assert.equal((await post(member, [asset], 'whiteboard')).status, 400);
    assert.equal((await post(member, [note, {...arrow, patch:{...arrow.patch, points:[[0, 0]]}}])).status, 400);
    assert.equal((await post(member, [{...note, patch:{...note.patch, imageId}}])).status, 400);
    assert.deepEqual((await read(admin)).json, {revision:0, items:[], imageTransforms:true});
    const saved = await post(member, [asset, note, arrow, frame]);
    assert.equal(saved.status, 200);
    assert.equal(saved.json.imageTransforms, true);
    assert.equal(saved.json.items[0].imageId, imageId);
    assert.equal(Object.hasOwn(saved.json.items[0], 'base64'), false);
    assert.equal(Object.hasOwn(saved.json.items[0], 'imageTransform'), false);
    assert.deepEqual(saved.json.items.map(item => item.kind), ['image', 'note', 'arrow', 'frame']);
    assert.deepEqual((await read(admin, 'whiteboard')).json, {revision:1, items:[saved.json.items[1]]});
    const legacyEdit = await post(admin, [{id:note.id, patch:{text:'仍可编辑'}}], 'whiteboard');
    assert.equal(legacyEdit.status, 200);
    assert.deepEqual(legacyEdit.json.items.map(item => item.kind), ['note']);

    const imageTransform = {rotation:-37.5, flipX:true, flipY:false, crop:[0.1, 0.2, 0.85, 0.95], opacity:0.65};
    const transformAsset = transform => ({id:asset.id, patch:{imageTransform:transform}});
    assert.equal((await post(member, [transformAsset({...imageTransform, crop:[0.8, 0, 0.2, 1]})])).status, 400);
    assert.equal((await post(member, [transformAsset({...imageTransform, opacity:1.5})])).status, 400);
    assert.equal((await post(member, [transformAsset({...imageTransform, rotation:361})])).status, 400);
    assert.equal((await post(member, [transformAsset({...imageTransform, unknown:true})])).status, 422);
    assert.equal((await post(member, [{id:note.id, patch:{imageTransform}}])).status, 400);
    assert.equal((await read(admin)).json.revision, 2);
    const transformed = await post(member, [transformAsset(imageTransform)]);
    assert.equal(transformed.status, 200);
    assert.deepEqual(transformed.json.items[0].imageTransform, imageTransform);
    assert.equal(transformed.json.items[0].imageId, imageId);
    const moved = await post(admin, [{id:asset.id, patch:{x:72}}]);
    assert.equal(moved.json.items[0].x, 72);
    assert.deepEqual(moved.json.items[0].imageTransform, imageTransform);

    const assetId = `team:${randomUUID()}`;
    const reference = {id:randomUUID(), patch:{kind:'image', x:14, y:21, width:96, height:72, text:'团队图片', assetId}};
    assert.equal((await post(member, [reference])).status, 400);
    assert.equal((await post(member, [{...reference, patch:{...reference.patch, imageId}}], referenceBoard)).status, 400);
    assert.equal((await post(member, [{...reference, patch:{...reference.patch, assetId:'personal:1'}}], referenceBoard)).status, 400);
    assert.equal((await post(member, [{id:note.id, patch:{assetId}}], referenceBoard)).status, 400);
    const referenced = await post(member, [reference], referenceBoard);
    assert.equal(referenced.status, 200);
    assert.equal(referenced.json.assetReferences, true);
    const checkReference = snapshot => snapshot.items.find(item => item.id === reference.id);
    assert.deepEqual(checkReference(referenced.json), {id:reference.id, ...reference.patch, color:'slate', points:[]});

    for (const route of ['whiteboard', extendedBoard]) {
      const older = await read(admin, route);
      assert.equal(Object.hasOwn(older.json, 'assetReferences'), false);
      assert.equal(checkReference(older.json), undefined);
      const unchanged = await post(admin, [{id:reference.id, patch:{x:200}}, {id:reference.id, delete:true}], route);
      assert.equal(unchanged.status, 200);
      assert.equal(unchanged.json.revision, referenced.json.revision);
    }

    await stopTeamServer(server);
    running = await startTeamServer(database);
    server = running.server;
    request = teamRequest(running.address);
    const reopened = (await read(admin)).json;
    assert.deepEqual(reopened.items.map(item => item.kind), ['image', 'note', 'arrow', 'frame']);
    assert.deepEqual(reopened.items[0].imageTransform, imageTransform);
    assert.deepEqual(await read(admin, imageRoute(imageId)), {status:200, json:pngImage});
    const reopenedReference = (await read(admin, referenceBoard)).json;
    assert.equal(reopenedReference.assetReferences, true);
    assert.deepEqual(checkReference(reopenedReference), checkReference(referenced.json));
    const refMoved = await post(admin, [{id:reference.id, patch:{y:80, imageTransform}}], referenceBoard);
    assert.equal(refMoved.status, 200);
    assert.deepEqual(checkReference(refMoved.json), {...checkReference(reopenedReference), y:80, imageTransform});

    const duplicate = {id:randomUUID(), patch:{...asset.patch, imageTransform}};
    const defaults = {rotation:0, flipX:false, flipY:false, crop:[0, 0, 1, 1], opacity:1};
    const copied = await post(member, [duplicate, transformAsset(defaults)], referenceBoard);
    assert.equal(copied.status, 200);
    assert.deepEqual(copied.json.items[0].imageTransform, defaults);
    assert.deepEqual(copied.json.items.find(item => item.id === duplicate.id).imageTransform, imageTransform);

    assert.equal(copied.json.restoreItems, true);
    assert.equal(Object.hasOwn((await read(admin)).json, 'restoreItems'), false);
    const originalReference = checkReference(copied.json);
    const {id:referenceId, ...restorePatch} = originalReference;
    const restore = {id:referenceId, restore:true, patch:restorePatch};
    const remove = {id:referenceId, delete:true};
    const firstDelete = await post(admin, [remove], referenceBoard);
    assert.equal(firstDelete.status, 200);
    assert.equal(checkReference(firstDelete.json), undefined);
    assert.equal((await post(member, [{id:referenceId, patch:restorePatch}], referenceBoard)).json.revision, firstDelete.json.revision);
    assert.equal((await post(member, [restore])).status, 400);
    assert.equal((await post(member, [{...restore, patch:{x:40}}], referenceBoard)).status, 400);
    assert.equal((await post(member, [{...remove, restore:true}], referenceBoard)).status, 400);
    assert.equal((await post(member, [{...restore, id:randomUUID()}], referenceBoard)).json.revision, firstDelete.json.revision);

    const restoreBatch = {operations:[restore], batchId:randomUUID()};
    const restored = await request('POST', referenceBoard, member, restoreBatch);
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.json.items, copied.json.items);
    assert.deepEqual((await request('POST', referenceBoard, member, restoreBatch)).json, restored.json);
    const restoredAgain = await post(member, [{...restore, patch:{...restore.patch, x:200}}], referenceBoard);
    assert.deepEqual(restoredAgain.json, restored.json);

    const secondDelete = await post(admin, [remove], referenceBoard);
    assert.equal(checkReference(secondDelete.json), undefined);
    assert.deepEqual((await request('POST', referenceBoard, member, restoreBatch)).json, secondDelete.json);
    const secondRestore = await post(member, [restore], referenceBoard);
    assert.equal(secondRestore.status, 200);
    assert.deepEqual(secondRestore.json.items, copied.json.items);

    const otherDatabase = path.join(scratch, 'other-team');
    const other = credentials((await exec(binary, ['--data', otherDatabase, 'init', '其他团队', '管理员'], {windowsHide:true})).stdout);
    const second = await startTeamServer(otherDatabase);
    try {
      const otherRequest = teamRequest(second.address);
      assert.equal((await otherRequest('GET', imageRoute(imageId), member)).status, 401);
      assert.equal((await otherRequest('GET', imageRoute(imageId), other)).status, 404);
      assert.equal((await otherRequest('POST', extendedBoard, other, {operations:[asset]})).status, 404);
    } finally {
      await stopTeamServer(second.server);
    }
  } finally {
    await stopTeamServer(server);
    await fs.rm(scratch, {recursive:true, force:true});
  }
});

test('team whiteboard projects isolate canvases and preserve the legacy default board', {timeout: 25_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-whiteboard-projects-'));
  const database = path.join(scratch, 'db');
  const cli = async (...args) => (await exec(binary, ['--data', database, ...args], {windowsHide:true})).stdout;
  const listRoute = 'whiteboard-projects';
  const itemId = randomUUID();
  const batchId = randomUUID();
  const creation = text => [{id:itemId, patch:{kind:'note', x:24, y:-19, width:200, height:160, text}}];
  let server;
  try {
    const admin = credentials(await cli('init', '白板项目', '管理员'));
    const member = credentials(await cli('member-add', '成员'));
    let running = await startTeamServer(database);
    server = running.server;
    let request = teamRequest(running.address);
    const create = (id, name) => request('POST', listRoute, member, {id,name});
    const rename = (id, name) => request('PATCH', listRoute + '/' + id, admin, {name});
    const read = (id, owner = admin) => request('GET', 'whiteboard' + (id ? '/' + id : ''), owner);
    const post = (id, operations, identity = member, receipt = batchId) =>
      request('POST', 'whiteboard' + (id ? '/' + id : ''), identity, {operations, batchId:receipt});
    const first = randomUUID();
    const second = randomUUID();
    const unknown = randomUUID();
    assert.equal((await request('GET', listRoute)).status, 401);
    assert.equal((await request('POST', listRoute, null, {id:first,name:'未授权'})).status, 401);
    assert.deepEqual((await request('GET', listRoute, member)).json, {
      projects:[{id:'default',name:'默认项目'}],
    });
    const legacy = (await post(null, creation('旧白板'))).json;
    assert.equal(legacy.revision, 1);
    assert.deepEqual((await read('default')).json, legacy);
    assert.equal((await create('default', '保留编号')).status, 400);
    assert.equal((await create(first, 'x'.repeat(81))).status, 400);
    assert.equal((await create(first, '内部\n换行')).status, 400);
    assert.equal((await create(first, '  第一项目  ')).status, 200);
    assert.equal((await create(second, '第二项目')).status, 200);
    assert.deepEqual((await read(first, member)).json, {revision:0,items:[]});
    assert.equal((await read(unknown)).status, 404);
    assert.equal((await post(unknown, creation('不存在'))).status, 404);
    assert.equal((await rename(unknown, '不存在')).status, 404);
    const boardOne = await post(first, creation('第一项目画布'));
    const boardTwo = await post(second, creation('第二项目画布'));
    assert.equal(boardOne.status, 200);
    assert.equal(boardTwo.status, 200);
    assert.equal(boardOne.json.revision, 1);
    assert.equal(boardTwo.json.revision, 1);
    assert.equal(boardOne.json.items[0].text, '第一项目画布');
    assert.equal(boardTwo.json.items[0].text, '第二项目画布');
    const updated = await post(first, [{id:itemId, patch:{text:'另一位成员编辑'}}], admin, randomUUID());
    assert.equal(updated.json.revision, 2);
    assert.deepEqual((await post(first, creation('第一项目画布'))).json, updated.json);
    assert.deepEqual((await read(second)).json, boardTwo.json);
    assert.deepEqual((await read(null)).json, legacy);

    const modernBoard = `whiteboard/${second}?extended=1&groups=1&connections=1`;
    const fallbackBoard = `whiteboard/${second}?extended=1`;
    const groupId = randomUUID();
    const anotherId = randomUUID();
    const arrowId = randomUUID();
    const connection = {from:{id:itemId, side:'right'}, to:{id:anotherId, side:'top'}};
    const arrowPatch = {kind:'arrow', x:0, y:10, width:60, height:72, points:[[0, 0], [60, 72]], connection};
    const setFeatures = (operations, route = modernBoard, identity = member) =>
      request('POST', route, identity, {operations, batchId:randomUUID()});
    assert.equal((await setFeatures([{id:itemId, patch:{groupId:'invalid group'}}])).status, 400);
    assert.equal((await setFeatures([{id:itemId, patch:{groupId}}], fallbackBoard)).status, 400);
    assert.equal((await setFeatures([{id:arrowId, patch:arrowPatch}], fallbackBoard)).status, 400);
    assert.equal((await setFeatures([{id:arrowId, patch:{...arrowPatch, connection:{...connection, to:connection.from}}}])).status, 400);
    assert.equal((await setFeatures([{id:arrowId, patch:{...arrowPatch, connection:{...connection, to:{id:arrowId, side:'top'}}}}])).status, 400);
    assert.equal((await setFeatures([{id:arrowId, patch:{...arrowPatch, connection:{...connection, to:{id:anotherId, side:'corner'}}}}])).status, 422);
    assert.equal((await setFeatures([{id:itemId, patch:{connection}}])).status, 400);
    const arranged = await setFeatures([
      {id:itemId, patch:{groupId}},
      {id:anotherId, patch:{kind:'note', x:64, y:32, width:210, height:140, groupId}},
      {id:arrowId, patch:arrowPatch},
    ]);
    assert.equal(arranged.status, 200);
    assert.equal(arranged.json.groups, true);
    assert.equal(arranged.json.connections, true);
    assert.deepEqual(arranged.json.items.map(item => item.groupId), [groupId, groupId, undefined]);
    assert.deepEqual(arranged.json.items[2].connection, connection);

    const previousClient = await setFeatures([{id:itemId, patch:{x:37}}, {id:arrowId, patch:{x:28}}], fallbackBoard, admin);
    assert.equal(previousClient.status, 200);
    assert.equal(Object.hasOwn(previousClient.json, 'groups'), false);
    assert.equal(Object.hasOwn(previousClient.json, 'connections'), false);
    assert.equal(Object.hasOwn(previousClient.json.items[0], 'groupId'), false);
    assert.equal(Object.hasOwn(previousClient.json.items[2], 'connection'), false);
    assert.deepEqual(previousClient.json.items[2].points, arrowPatch.points);

    assert.equal((await rename('default', '已有项目')).status, 200);
    assert.equal((await rename(first, '改名后的项目')).status, 200);
    const expected = {projects:[
      {id:'default',name:'已有项目'}, {id:first,name:'改名后的项目'}, {id:second,name:'第二项目'},
    ]};
    assert.deepEqual((await create(first, '第一项目')).json, expected);
    await stopTeamServer(server);
    running = await startTeamServer(database);
    server = running.server;
    request = teamRequest(running.address);
    assert.deepEqual((await request('GET', listRoute, member)).json, expected);
    assert.deepEqual((await read('default')).json, legacy);
    assert.deepEqual((await post(first, creation('第一项目画布'))).json, updated.json);
    const reopenedFeatures = (await request('GET', modernBoard, member)).json;
    assert.equal(reopenedFeatures.groups, true);
    assert.equal(reopenedFeatures.connections, true);
    assert.deepEqual(reopenedFeatures.items.map(item => item.groupId), [groupId, groupId, undefined]);
    assert.deepEqual(reopenedFeatures.items[2].connection, connection);
    assert.equal(reopenedFeatures.items[0].x, 37);
    assert.equal(reopenedFeatures.items[2].x, 28);
    const ungrouped = await setFeatures([{id:itemId, patch:{groupId:''}}, {id:anotherId, patch:{groupId:''}}]);
    assert.equal(ungrouped.status, 200);
    assert.ok(ungrouped.json.items.every(item => !Object.hasOwn(item, 'groupId')));
    assert.deepEqual(ungrouped.json.items[2].connection, connection);
  } finally {
    await stopTeamServer(server);
    await fs.rm(scratch, {recursive:true, force:true});
  }
});

test('team quick access shares folder changes by member and survives restart', {timeout: 25_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-team-test-'));
  const database = path.join(scratch, 'db');
  const cli = async (...args) => (await exec(binary, ['--data', database, ...args], {windowsHide:true})).stdout;
  const route = 'quick-access';
  let server;
  try {
    const admin = credentials(await cli('init', '快速访问', '管理员'));
    const member = credentials(await cli('member-add', '成员'));
    let running = await startTeamServer(database);
    server = running.server;
    let request = teamRequest(running.address);
    assert.equal((await request('GET', route)).status, 401);
    assert.deepEqual((await request('GET', route, member)).json, {pins:[], revision:0});

    const library = {id:randomUUID(), name:'参考资料', watching:false};
    const files = ['旧目录/子目录/model.fbx', '其他目录/model.fbx'].map(relativePath =>
      ({relativePath, name:'model', size:8, modified:1, tags:[], notes:''}));
    assert.equal((await request('POST', 'publish', admin, {library, files, complete:true})).status, 200);
    const pin = folder => ({libraryId:library.id, folder});
    const add = (identity, folder) => request('PUT', route, identity, {...pin(folder), pinned:true});
    assert.equal((await add(member, '../目录')).status, 400);
    assert.equal((await add(member, '不存在')).status, 409);
    const added = await Promise.all([add(member, '旧目录/子目录'), add(admin, '其他目录')]);
    assert.ok(added.every(result => result.status === 200));
    const snapshot = (await request('GET', route, member)).json;
    assert.deepEqual(new Set(snapshot.pins.map(row => row.folder)), new Set(['旧目录/子目录', '其他目录']));
    assert.equal((await add(member, '旧目录/子目录')).json.revision, snapshot.revision);

    files[0].relativePath = '新目录/子目录/model.fbx';
    assert.equal((await request('POST', 'publish', admin, {library, files, complete:true})).status, 200);
    const relocated = await request('POST', route + '/relocate', member, {libraryId:library.id, from:'旧目录', to:'新目录'});
    assert.equal(relocated.status, 200);
    assert.ok(relocated.json.pins.some(row => row.folder === '新目录/子目录'));
    assert.ok(relocated.json.revision > snapshot.revision);
    await stopTeamServer(server);
    running = await startTeamServer(database);
    server = running.server;
    request = teamRequest(running.address);
    assert.deepEqual((await request('GET', route, admin)).json, relocated.json);
    const removed = await request('PUT', route, member, {...pin('新目录/子目录'), pinned:false});
    assert.deepEqual(removed.json.pins, [pin('其他目录')]);
    assert.deepEqual((await request('GET', route, admin)).json, removed.json);
  } finally {
    await stopTeamServer(server);
    await removeTeamScratch(scratch);
  }
});

async function removeTeamScratch(scratch) {
  const allowed = path.resolve(os.tmpdir()) + path.sep;
  if (path.resolve(scratch).startsWith(allowed) && path.basename(scratch).startsWith('nexus-team-test-')) {
    await fs.rm(scratch, {recursive: true, force: true});
  }
}

test('team creator subscriptions persist across members and reject stale changes', {timeout: 25_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-team-test-'));
  const database = path.join(scratch, 'db');
  const cli = async (...args) => (await exec(binary, ['--data', database, ...args], {
    windowsHide: true, encoding: 'utf8',
  })).stdout;
  const route = 'creative-subscriptions';
  const creator = {
    url:'https://space.bilibili.com/123/',
    name:'美术参考', detectedName:'公开作者', feed:'https://feeds.example.com/artist.atom',
    avatarUrl:'https://i0.hdslb.com/bfs/face/reference.png', bio:'创作者简介',
  };
  let server;
  try {
    await cli('init', '订阅团队', '管理员');
    const first = credentials(await cli('member-add', '成员甲'));
    const second = credentials(await cli('member-add', '成员乙'));
    let running = await startTeamServer(database);
    server = running.server;
    let request = teamRequest(running.address);
    assert.equal((await request('GET', route)).status, 401);
    assert.equal((await request('POST', route, first, creator, {origin:'https://example.com'})).status, 401);
    assert.deepEqual((await request('GET', route, first)).json, {available:true, subscriptions:[]});

    for (const url of ['file:///C:/asset', 'https://127.0.0.1/author', 'https://[::1]/author',
      'https://host.local/author', 'https://person:password@example.com']) {
      assert.equal((await request('POST', route, first, {...creator,url})).status, 400);
    }
    assert.equal((await request('POST', route, first, {...creator,feed:'http://example.com/rss'})).status, 400);
    assert.equal((await request('POST', route, first, {...creator,name:'不可\u0000用'})).status, 400);

    const initial = await request('POST', route, first, creator);
    assert.equal(initial.status, 200);
    assert.equal(initial.json.created, true);
    const original = initial.json.subscription;
    assert.deepEqual(original, {...creator,id:original.id,revision:1,url:'https://space.bilibili.com/123'});
    assert.deepEqual((await request('GET', route, second)).json.subscriptions, [original]);
    const duplicate = await request('POST', route, second, {
      ...creator, url:'https://SPACE.bilibili.com/123/?visit=other#about', name:'不覆盖团队名称',
    });
    assert.deepEqual(duplicate.json, {subscription:original,created:false});

    const added = await Promise.all([first, second].map((member, index) => request('POST', route, member, {
      url:'https://example.com/author-'+index, avatarUrl:'https://untrusted.example.com/face.png',
    })));
    assert.ok(added.every(result => result.status === 200 && result.json.created && result.json.subscription.avatarUrl === ''));
    const record = `${route}/${original.id}`;
    const updated = await request('PATCH', record, second, {revision:1, subscription:{...creator,name:'已统一名称'}});
    assert.equal(updated.status, 200);
    assert.equal(updated.json.subscription.revision, 2);
    assert.equal((await request('PATCH', record, first, {revision:1, subscription:creator})).status, 409);
    assert.equal((await request('DELETE', record, first, {revision:1})).status, 409);
    assert.equal((await request('GET', route, first)).json.subscriptions.length, 3);

    await stopTeamServer(server);
    running = await startTeamServer(database);
    server = running.server;
    request = teamRequest(running.address);
    const persisted = (await request('GET', route, first)).json.subscriptions;
    assert.deepEqual(persisted[0], updated.json.subscription);
    assert.equal(persisted.length, 3);
    assert.deepEqual((await request('DELETE', record, first, {revision:2})).json, {removed:true});
    assert.deepEqual((await request('DELETE', record, second, {revision:2})).json, {removed:false});
    assert.equal((await request('GET', route, second)).json.subscriptions.length, 2);
    await cli('member-disable', second.id);
    assert.equal((await request('GET', route, second)).status, 401);
  } finally {
    await stopTeamServer(server);
    await removeTeamScratch(scratch);
  }
});

test('team favorites and collections synchronize independent member edits', {timeout: 25_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-team-test-'));
  const database = path.join(scratch, 'db');
  const cli = async (...args) => (await exec(binary, ['--data', database, ...args], {
    windowsHide:true, encoding:'utf8',
  })).stdout;
  const route = 'organization';
  let server;
  try {
    const admin = credentials(await cli('init', '合集团队', '管理员'));
    const first = credentials(await cli('member-add', '成员甲'));
    const second = credentials(await cli('member-add', '成员乙'));
    let running = await startTeamServer(database);
    server = running.server;
    let request = teamRequest(running.address);
    assert.equal((await request('GET', route)).status, 401);
    assert.deepEqual((await request('GET', route, first)).json, {
      available:true, revision:0, favoriteIds:[], favoriteTimes:{}, collections:[],
    });

    const library = {id:randomUUID(), name:'参考资料', watching:false};
    const files = ['a', 'b', 'c'].map(name => ({relativePath:name+'.fbx',name,size:8,modified:1,tags:[],notes:''}));
    assert.equal((await request('POST', 'publish', admin, {library,files,complete:true})).status, 200);
    const catalog = (await request('GET', 'catalog/full', first)).json;
    const [firstAsset, secondAsset, thirdAsset] = catalog.catalog.assets.map(asset => asset.id);
    const favorite = id => `${route}/favorites/${id}`;
    const favoriteResults = await Promise.all([[first,firstAsset],[second,secondAsset]].map(([member, id]) =>
      request('PATCH', favorite(id), member, {favorite:true})));
    assert.ok(favoriteResults.every(result => result.status === 200 && result.json.favorite && result.json.favoriteAt > 0));
    assert.equal((await request('PATCH', favorite(randomUUID()), first, {favorite:true})).status, 404);
    const repeatFavorite = (await request('PATCH', favorite(firstAsset), second, {favorite:true})).json;
    assert.equal(repeatFavorite.revision, 2);
    assert.equal(repeatFavorite.favoriteAt, favoriteResults[0].json.favoriteAt);

    const created = await request('POST', `${route}/collections`, first, {name:'References'});
    assert.equal(created.status, 200);
    assert.equal((await request('POST', `${route}/collections`, second, {name:'references'})).status, 409);
    const collection = `${route}/collections/${created.json.id}`;
    const added = await Promise.all([[first,firstAsset],[second,secondAsset]].map(([member, id]) =>
      request('PATCH', collection+'/members', member, {assetIds:[id,id],include:true})));
    assert.ok(added.every(result => result.status === 200));
    assert.equal((await request('PATCH', collection+'/members', first, {assetIds:[thirdAsset,randomUUID()],include:true})).status, 404);
    const shared = (await request('GET', route, second)).json;
    assert.deepEqual(shared.favoriteIds.sort(), [firstAsset,secondAsset].sort());
    assert.deepEqual(shared.favoriteTimes, {
      [firstAsset]:favoriteResults[0].json.favoriteAt, [secondAsset]:favoriteResults[1].json.favoriteAt,
    });
    assert.deepEqual(shared.collections[0].assetIds.sort(), [firstAsset,secondAsset].sort());
    assert.equal(shared.revision, 5);
    assert.equal((await request('GET', 'catalog/full', second)).json.revision, catalog.revision);

    const renamed = await request('PATCH', collection, second, {name:'团队参考'});
    assert.equal(renamed.json.name, '团队参考');
    await stopTeamServer(server);
    running = await startTeamServer(database);
    server = running.server;
    request = teamRequest(running.address);
    const restarted = (await request('GET', route, first)).json;
    assert.deepEqual(restarted.collections, [renamed.json]);
    assert.deepEqual(restarted.favoriteTimes, shared.favoriteTimes);
    assert.equal((await request('PATCH', favorite(firstAsset), first, {favorite:false})).json.favorite, false);
    assert.deepEqual((await request('DELETE', collection, second)).json, {removed:true});
    const final = (await request('GET', route, first)).json;
    assert.deepEqual(final.favoriteIds, [secondAsset]);
    assert.deepEqual(final.favoriteTimes, {[secondAsset]:favoriteResults[1].json.favoriteAt});
    assert.deepEqual(final.collections, []);
    assert.equal(final.revision, 8);
  } finally {
    await stopTeamServer(server);
    await removeTeamScratch(scratch);
  }
});

test('members link independent directories within configured NAS sources and reuse existing watches', {timeout: 30_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-team-test-'));
  const database = path.join(scratch, 'db');
  const allowed = path.join(scratch, '授权目录');
  const original = path.join(allowed, '父目录', '已有资料库');
  const nested = path.join(original, '已索引内容');
  const newRoot = path.join(allowed, '04_参考片_样片');
  const fixtures = [
    {file:'下载样片.WEBM', ext:'webm', kind:'video', contents:'mock WebM payload'},
    {file:'规格.PDF', ext:'pdf', kind:'other', contents:'mock PDF payload'},
    {file:'交付.ifc', ext:'ifc', kind:'bim', contents:'mock IFC payload'},
    {file:'平面.STEP', ext:'step', kind:'cad', contents:'mock STEP payload'},
    {file:'配乐.wav', ext:'wav', kind:'audio', contents:'mock WAVE payload'},
    {file:'工具.py', ext:'py', kind:'script', contents:"from pathlib import Path\nPath(__file__).with_name('index-script-ran.marker').write_text('unexpected')\n"},
  ];
  const unc = '\\\\192.168.0.106\\Dotin_Work\\_Dotin_Asset';
  const environment = {NEXUS_TEAM_SOURCE_ROOTS: JSON.stringify([{id:'assets', path:allowed, unc}])};
  const cli = async (...args) => (await exec(binary, ['--data', database, ...args], {
    windowsHide: true, encoding: 'utf8',
  })).stdout;
  let server;
  try {
    await fs.mkdir(nested, {recursive:true});
    await fs.mkdir(path.join(original, '04_参考片_样片'));
    await fs.mkdir(newRoot);
    await fs.mkdir(path.join(newRoot, '已单独移除'));
    await fs.mkdir(path.join(newRoot, '版本.v2'));
    await fs.writeFile(path.join(nested, 'original.obj'), 'v 0 0 0\n');
    await fs.writeFile(path.join(newRoot, '样片.mp4'), 'mock video payload');
    await fs.writeFile(path.join(newRoot, '版本.v2', 'README'), 'no extension');
    await fs.writeFile(path.join(newRoot, '仍在下载.WEBM.crdownload'), 'incomplete file');
    for (const {file, contents} of fixtures) await fs.writeFile(path.join(newRoot, file), contents);
    const admin = credentials(await cli('init', '来源测试', '管理员'));
    const first = credentials(await cli('member-add', '设计甲'));
    const second = credentials(await cli('member-add', '设计乙'));
    const originalLibrary = {id:randomUUID(), name:'原有资料库'};
    let running = await startConfiguredTeamServer(database, environment);
    server = running.server;
    let request = teamRequest(running.address);
    assert.equal((await request('GET', 'source-roots')).status, 401);
    assert.deepEqual((await request('GET', 'source-roots', first)).json, {roots:[{id:'assets',unc}]});
    assert.equal((await request('POST','publish',admin,{library:originalLibrary,files:[],complete:false})).status,200);
    await cli('library-watch', originalLibrary.id, original);
    assert.equal((await request('POST', 'libraries/' + originalLibrary.id + '/refresh', first)).status, 200);
    const before = (await request('GET', 'catalog/full', first)).json;
    const originalId = before.catalog.assets[0].id;
    const route = 'source-roots/assets/libraries';
    for (const folder of ['', '../外部', '/absolute', '.nexus', '04_参考片_样片/样片.mp4']) {
      assert.equal((await request('POST', route, first, {folder})).status, 400, folder);
    }
    assert.equal((await request('POST', 'source-roots/unknown/libraries', first, {folder:'04_参考片_样片'})).status, 404);
    const reuse = await request('POST', route, first, {folder:'父目录/已有资料库/已索引内容'});
    assert.equal(reuse.status, 200);
    assert.deepEqual(reuse.json, {libraryId:originalLibrary.id,folder:'已索引内容',created:false,indexPending:false});
    const joined = await Promise.all([first,second].map(identity => request('POST', route, identity, {folder:'04_参考片_样片'})));
    assert.ok(joined.every(item => item.status === 200 && item.json.indexPending === false));
    assert.deepEqual(joined.map(item => item.json.created).sort(), [false,true]);
    const newId = joined[0].json.libraryId;
    assert.equal(joined[1].json.libraryId, newId);
    assert.equal(joined[0].json.folder, '');
    let newAsset;
    for (const identity of [first,second]) {
      const {catalog} = (await request('GET', 'catalog/full', identity)).json;
      assert.deepEqual(catalog.libraries.map(item => item.id).sort(), [newId,originalLibrary.id].sort());
      assert.ok(catalog.libraries.every(item => item.watching));
      assert.deepEqual(catalog.sourcePaths, {[newId]:unc+'\\04_参考片_样片',[originalLibrary.id]:unc+'\\父目录\\已有资料库'});
      assert.ok(catalog.linkedFolders.some(link => link.libraryId===newId && link.folder===''));
      assert.ok(catalog.linkedFolders.some(link => link.libraryId===originalLibrary.id && link.folder==='已索引内容'));
      assert.equal(catalog.assets.length, 2 + fixtures.length);
      assert.equal(catalog.assets.find(item => item.relativePath === '已索引内容/original.obj').id, originalId);
      newAsset = catalog.assets.find(item => item.relativePath === '样片.mp4');
      assert.equal(newAsset.kind, 'video');
      for (const {file, ext, kind} of fixtures) {
        const indexed = catalog.assets.find(item => item.relativePath === file);
        assert.equal(indexed?.kind, kind, file);
        assert.equal(indexed?.ext, ext, file);
      }
      assert.ok(!catalog.assets.some(item => item.relativePath.endsWith('README') || item.ext === 'crdownload'));
    }
    const tagged = await request('PATCH', 'assets/' + newAsset.id, first, {
      revision: newAsset.revision, tags: ['保留标签'], notes: '保留备注',
    });
    assert.equal(tagged.status, 200);
    const hide = (libraryId, folder) => request('PATCH', 'folder-visibility', first, {libraryId, folder, hidden:true});
    assert.equal((await hide(originalLibrary.id, '04_参考片_样片')).status, 200);
    assert.equal((await hide(newId, '已单独移除')).status, 200);
    assert.equal((await hide(newId, '')).status, 200);
    assert.equal((await request('POST', 'libraries/' + newId + '/refresh', second)).status, 200);
    let afterHide = (await request('GET', 'catalog/full', second)).json.catalog;
    assert.equal(afterHide.libraries.some(item => item.id === newId), false);
    assert.equal(afterHide.assets.some(item => item.libraryId === newId), false);
    const restored = await request('POST', route, second, {folder:'04_参考片_样片'});
    assert.deepEqual(restored.json, {libraryId:newId,folder:'',created:false,indexPending:false});
    afterHide = (await request('GET', 'catalog/full', first)).json.catalog;
    assert.equal(afterHide.libraries.some(item => item.id === newId), true);
    const restoredAsset = afterHide.assets.find(item => item.id === newAsset.id);
    assert.equal(restoredAsset.id, newAsset.id);
    assert.deepEqual(restoredAsset.tags, ['保留标签']);
    assert.equal(restoredAsset.notes, '保留备注');
    assert.deepEqual(new Set(afterHide.hiddenFolders.map(item=>`${item.libraryId}/${item.folder}`)), new Set([
      `${originalLibrary.id}/04_参考片_样片`, `${newId}/已单独移除`,
    ]));
    assert.equal((afterHide.visibleFolders?.[newId] ?? []).includes('已单独移除'), false);
    assert.equal(await fs.readFile(path.join(newRoot,'样片.mp4'),'utf8'),'mock video payload');
    for (const {file, contents} of fixtures) assert.equal(await fs.readFile(path.join(newRoot, file), 'utf8'), contents);
    await assert.rejects(fs.stat(path.join(newRoot, 'index-script-ran.marker')), {code:'ENOENT'});
    await stopTeamServer(server);
    running = await startConfiguredTeamServer(database, environment);
    server = running.server;
    request = teamRequest(running.address);
    assert.equal((await request('GET','catalog/full',second)).json.catalog.sourcePaths[newId], unc+'\\04_参考片_样片');

    const siblingFolder = path.join(allowed, '父目录', '第二个子库', '空子目录');
    await fs.mkdir(siblingFolder, {recursive:true});
    await fs.writeFile(path.join(path.dirname(siblingFolder), '场景.obj'), 'v 1 0 0\n');
    const sibling = await request('POST', route, second, {folder:'父目录/第二个子库'});
    const siblingId = sibling.json.libraryId;
    assert.equal(sibling.status, 200);
    const beforeMerge = (await request('GET', 'catalog/full', first)).json.catalog;
    const originalAsset = beforeMerge.assets.find(item => item.id === originalId);
    const siblingAsset = beforeMerge.assets.find(item => item.libraryId === siblingId);
    assert.equal((await request('PATCH', 'assets/' + originalId, first, {
      revision:originalAsset.revision, tags:['不丢标签'], notes:'不丢备注', rating:4,
    })).status, 200);
    const parent = await request('POST', route, first, {folder:'父目录'});
    const parentId = parent.json.libraryId;
    assert.deepEqual(parent, {status:200,json:{libraryId:parentId,folder:'',created:true,indexPending:false,
      consolidated:[
        {previousLibraryId:siblingId,libraryId:parentId,folder:'第二个子库'},
        {previousLibraryId:originalLibrary.id,libraryId:parentId,folder:'已有资料库'},
      ].sort((a,b)=>a.folder<b.folder ? -1 : 1),
    }});
    const afterMerge = (await request('GET', 'catalog/full', second)).json;
    assert.deepEqual(afterMerge.catalog.libraries.map(item=>item.id).sort(), [newId,parentId].sort());
    assert.equal(afterMerge.catalog.sourcePaths[parentId], unc+'\\父目录');
    assert.equal(afterMerge.catalog.sourcePaths[originalLibrary.id], undefined);
    assert.ok(afterMerge.catalog.linkedFolders.some(link=>link.libraryId===parentId && link.folder===''));
    assert.ok(afterMerge.catalog.linkedFolders.some(link=>link.libraryId===parentId && link.folder==='已有资料库/已索引内容'));
    assert.ok(!afterMerge.catalog.linkedFolders.some(link=>link.libraryId===parentId && link.folder==='第二个子库'));
    assert.ok(afterMerge.catalog.visibleFolders[parentId].includes('第二个子库/空子目录'));
    assert.ok(!afterMerge.catalog.visibleFolders[parentId].includes('已有资料库/04_参考片_样片'));
    const moved = afterMerge.catalog.assets.find(item=>item.id===originalId);
    assert.equal(moved.libraryId, parentId);
    assert.equal(moved.relativePath, '已有资料库/已索引内容/original.obj');
    assert.equal(moved.storageLibraryId, originalLibrary.id);
    assert.equal(moved.storageFolder, '已有资料库');
    assert.deepEqual(moved.tags, ['不丢标签']);
    assert.equal(moved.notes, '不丢备注');
    assert.equal(moved.rating, 4);
    const movedSibling = afterMerge.catalog.assets.find(item=>item.id===siblingAsset.id);
    assert.equal(movedSibling.relativePath, '第二个子库/场景.obj');
    assert.equal(movedSibling.libraryId, parentId);
    assert.equal((await request('POST', 'libraries/' + siblingId + '/refresh', second)).status, 409);
    const repeated = await request('POST', route, second, {folder:'父目录'});
    assert.deepEqual(repeated.json, {...parent.json,created:false});
    assert.equal((await request('GET', 'catalog/' + afterMerge.revision, second)).json.catalog, null);
  } finally {
    await stopTeamServer(server);
    await removeTeamScratch(scratch);
  }
});

test('defined team labels sync before use and rename or remove associated asset tags atomically', {timeout: 20_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-team-test-'));
  const database = path.join(scratch, 'db');
  const cli = async (...args) => (await exec(binary, ['--data', database, ...args], {
    windowsHide: true, encoding: 'utf8',
  })).stdout;
  let server;
  try {
    const admin = credentials(await cli('init', '标签测试', '管理员'));
    const first = credentials(await cli('member-add', '美术甲'));
    const second = credentials(await cli('member-add', '美术乙'));
    let running = await startTeamServer(database);
    server = running.server;
    let request = teamRequest(running.address);
    const before = (await request('GET','catalog/full',first)).json.revision;
    assert.equal((await request('POST','tags',null,{name:'未授权'})).status,401);
    for (const name of ['', 'a'.repeat(41), '行\n中']) {
      assert.equal((await request('POST','tags',first,{name})).status,400);
    }
    const created = await request('POST','tags',first,{name:'  Review/待审核  '});
    assert.deepEqual(created, {status:200,json:{name:'Review/待审核',created:true,revision:before+1}});
    const synced = (await request('GET','catalog/'+before,second)).json.catalog;
    assert.deepEqual(synced.assets,[]);
    assert.deepEqual(synced.definedTags,['Review/待审核']);
    const repeat = await request('POST','tags',second,{name:'review/待审核'});
    assert.deepEqual(repeat.json,{name:'Review/待审核',created:false,revision:before+1});
    assert.equal((await request('GET','catalog/'+(before+1),first)).json.catalog,null);
    await stopTeamServer(server);
    running = await startTeamServer(database);
    server = running.server;
    request = teamRequest(running.address);
    assert.deepEqual((await request('GET','catalog/full',second)).json.catalog.definedTags,['Review/待审核']);

    const library = {id:randomUUID(),name:'标签资料库'};
    const file = {relativePath:'scene.obj',name:'模型',size:12,modified:1,tags:['保留','Review/待审核','review/待审核'],notes:'保留备注'};
    assert.equal((await request('POST','publish',admin,{library,files:[file],complete:true})).status,200);
    assert.equal((await request('PATCH','tags',second,{name:'review/待审核',newName:'保留'})).status,409);
    const original = (await request('GET','catalog/full',first)).json;
    const previous = original.catalog.assets[0];
    const renamed = await request('PATCH','tags',second,{name:'review/待审核',newName:'REVIEW/待审核'});
    assert.deepEqual(renamed.json,{name:'REVIEW/待审核',revision:original.revision+1});
    const changed = (await request('GET','catalog/'+original.revision,first)).json.catalog;
    assert.deepEqual(changed.definedTags,['REVIEW/待审核']);
    assert.deepEqual(changed.assets[0].tags,['保留','REVIEW/待审核']);
    assert.equal(changed.assets[0].notes,'保留备注');
    assert.equal(changed.assets[0].revision,previous.revision+1);
    assert.equal((await request('PATCH','assets/'+previous.id,first,{revision:previous.revision,notes:'过期草稿'})).status,409);
    assert.equal((await request('POST','publish',admin,{library,files:[],complete:true})).status,200);
    assert.equal((await request('DELETE','tags',second,{name:'review/待审核'})).status,200);
    assert.equal((await request('POST','publish',admin,{library,files:[file],complete:true})).status,200);
    const deleted = (await request('GET','catalog/full',first)).json;
    assert.deepEqual(deleted.catalog.definedTags ?? [],[]);
    assert.deepEqual(deleted.catalog.assets[0].tags,['保留']);
    assert.equal(deleted.catalog.assets[0].notes,'保留备注');
    assert.equal((await request('DELETE','tags',second,{name:'REVIEW/待审核'})).json.revision,deleted.revision);
  } finally {
    await stopTeamServer(server);
    await removeTeamScratch(scratch);
  }
});

test('members edit only their own profile and share versioned avatars through the team service', {timeout: 25_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-team-test-'));
  const database = path.join(scratch, 'db');
  const cli = async (...args) => (await exec(binary, ['--data', database, ...args], {
    windowsHide: true, encoding: 'utf8',
  })).stdout;
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAAxElEQVR4nO3RMREAIBDAsFeCOtRhEmQwNEP33mXW2Vf/mt8D9QAAaAcAQDsAANoBANAOAIB2AAC0AwCgHQAA7QAAaAcAQDsAANoBANAOAIB2AAC0AwCgHQAA7QAAaAcAQDsAANoBANAOAIB2AAC0AwCgHQAA7QAAaAcAQDsAANoBANAOAIB2AAC0AwCgHQAA7QAAaAcAQDsAANoBANAOAIB2AAC0AwCgHQAA7QAAaAcAQDsAANoBANAOAIB2AAC0AwCg3QN1XhCTyEPk1wAAAABJRU5ErkJggg==';
  let server;
  try {
    await cli('init', '成员资料测试', '管理员');
    const first = credentials(await cli('member-add', '美术甲'));
    const peer = credentials(await cli('member-add', '美术乙'));
    let running = await startTeamServer(database);
    server = running.server;
    let request = teamRequest(running.address);
    const url = 'members/' + first.id + '/avatar';
    assert.equal((await request('GET', 'info')).status, 401);
    assert.equal((await request('GET', 'profile')).status, 401);
    assert.equal((await request('GET', url)).status, 401);
    const original = (await request('GET', 'profile', first)).json;
    assert.deepEqual(original, {name: '美术甲', avatarUrl: null});
    assert.deepEqual((await request('GET', url, peer)).json, {avatarUrl: null});
    const initialCatalog = (await request('GET', 'catalog/full', first)).json;
    const catalogRevision = initialCatalog.revision;
    const info = await request('GET', 'info', first);
    assert.equal(info.status, 200);
    const {serverVersion, ...existingIdentity} = info.json;
    assert.match(serverVersion, /^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/);
    assert.deepEqual(existingIdentity, {teamId:initialCatalog.team.id, memberId:first.id, role:'member'});

    assert.equal((await request('PATCH', 'profile', first, {name: '\n', avatarAction: 'keep'})).status, 400);
    assert.equal((await request('PATCH', 'profile', first, {
      name: '应撤回的昵称', avatarAction: 'replace', avatarUrl: 'data:image/png;base64,AAA=',
    })).status, 400);
    assert.deepEqual((await request('GET', 'profile', first)).json, original);
    const saved = await request('PATCH', 'profile', first, {
      name: '  新昵称 🎨  ', avatarAction: 'replace', avatarUrl: png, memberId: peer.id,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.name, '新昵称 🎨');
    assert.ok(saved.json.avatarUrl.startsWith('data:image/png;base64,'));
    const bytes = Buffer.from(saved.json.avatarUrl.split(',')[1], 'base64');
    assert.equal(bytes.readUInt32BE(16), 96);
    assert.equal(bytes.readUInt32BE(20), 96);
    assert.deepEqual((await request('GET', 'profile', peer)).json, {name: '美术乙', avatarUrl: null});
    assert.deepEqual((await request('GET', url, peer)).json, {avatarUrl: saved.json.avatarUrl});

    await request('POST', 'presence', first);
    let visible = (await request('POST', 'presence', peer)).json.members.find(member => member.id === first.id);
    assert.equal(visible.name, '新昵称 🎨');
    assert.match(visible.avatarRevision, /^[0-9a-f]{64}$/);
    assert.equal(Object.hasOwn(visible, 'avatarUrl'), false);
    const sameRevision = (await request('GET', 'catalog/' + catalogRevision, first)).json;
    assert.equal(sameRevision.member.name, '新昵称 🎨');
    assert.equal(sameRevision.catalog, null);

    await stopTeamServer(server);
    running = await startTeamServer(database);
    server = running.server;
    request = teamRequest(running.address);
    assert.deepEqual((await request('GET', 'profile', first)).json, saved.json);
    const keep = await request('PATCH', 'profile', first, {name: '已改名', avatarAction: 'keep'});
    assert.deepEqual(keep.json, {name: '已改名', avatarUrl: saved.json.avatarUrl});
    assert.deepEqual((await request('PATCH', 'profile', first, {name: '已改名', avatarAction: 'remove'})).json,
      {name: '已改名', avatarUrl: null});
    assert.deepEqual((await request('GET', url, peer)).json, {avatarUrl: null});
    await request('POST', 'presence', first);
    visible = (await request('POST', 'presence', peer)).json.members.find(member => member.id === first.id);
    assert.equal(Object.hasOwn(visible, 'avatarRevision'), false);
    await cli('member-disable', first.id);
    assert.equal((await request('GET', 'profile', first)).status, 401);
    assert.equal((await request('GET', url, peer)).status, 404);
  } finally {
    await stopTeamServer(server);
    await removeTeamScratch(scratch);
  }
});

test('regular members share NAS folder links with no copies or duplicate asset records', {timeout: 25_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-team-test-'));
  const database = path.join(scratch, 'db');
  const mount = path.join(scratch, '共享素材');
  const source = path.join(mount, '项目', '场景');
  const empty = path.join(mount, '项目', '空目录');
  const seed = 'v 0 0 0\n';
  const cli = async (...args) => (await exec(binary, ['--data', database, ...args], {
    windowsHide: true, encoding: 'utf8',
  })).stdout;
  let server;
  try {
    await fs.mkdir(source, {recursive: true});
    await fs.mkdir(path.join(source, '已单独移除'));
    await fs.mkdir(empty);
    await fs.writeFile(path.join(source, 'original.obj'), seed);
    const outsider = path.join(scratch, '不在团队目录');
    await fs.mkdir(outsider);
    await fs.symlink(outsider, path.join(mount, '外部跳转'), process.platform === 'win32' ? 'junction' : 'dir')
      .catch(error => { if (error.code !== 'EPERM') throw error; });
    const admin = credentials(await cli('init', '文件夹关联测试', '管理员'));
    const first = credentials(await cli('member-add', '设计师甲'));
    const second = credentials(await cli('member-add', '设计师乙'));
    let running = await startTeamServer(database);
    server = running.server;
    let request = teamRequest(running.address);
    const library = {id: randomUUID(), name: '共享模型库'};
    const route = 'libraries/' + library.id + '/links';
    const refresh = 'libraries/' + library.id + '/refresh';
    const folders = ['项目/场景', '项目/空目录'];
    const links = req => req.json.catalog.linkedFolders ?? [];
    assert.equal((await request('POST', route, null, {folders})).status, 401);
    assert.equal((await request('POST', 'publish', admin, {library, files: [], complete: true})).status, 200);
    assert.equal((await request('POST', route, first, {folders})).status, 409);
    await cli('library-watch', library.id, mount);
    assert.equal((await request('POST', refresh, first)).status, 200);
    const initial = (await request('GET', 'catalog/full', first)).json;
    assert.equal(initial.catalog.assets.length, 1);
    const asset = initial.catalog.assets[0].id;

    const result = await request('POST', route, first, {folders: [
      ...folders, ...folders, '../不在团队目录', '.nexus', '项目/不存在', '项目/场景/original.obj', '外部跳转',
    ]});
    assert.equal(result.status, 200);
    assert.equal(result.json.linked, 2);
    assert.equal(result.json.existing, 2);
    assert.equal(result.json.failed, 5);
    assert.deepEqual(result.json.folders, folders);
    let synced = await request('GET', 'catalog/' + initial.revision, second);
    assert.deepEqual(links(synced).map(link => link.folder).sort(), [...folders].sort());
    assert.ok(links(synced).every(link => link.libraryId === library.id));
    assert.deepEqual(synced.json.catalog.assets.map(cur => cur.id), [asset]);
    const repeat = await request('POST', route, second, {folders});
    assert.equal(repeat.json.linked, 0);
    assert.equal(repeat.json.existing, 2);
    assert.equal(repeat.json.revision, result.json.revision);

    const visibleFolders = catalog => catalog.visibleFolders?.[library.id] ?? [];
    const hide = folder => request('PATCH', 'folder-visibility', second, {libraryId: library.id, folder, hidden:true});
    const missing = '项目/不存在';
    const retainedRules = [folders[1], folders[0]+'/已单独移除', missing];
    for (const folder of ['', '项目', folders[0], ...retainedRules]) {
      assert.equal((await hide(folder)).status, 200);
    }
    assert.equal((await request('POST', refresh, second)).status, 200);
    synced = await request('GET', 'catalog/full', first);
    assert.deepEqual(links(synced), []);
    assert.deepEqual(synced.json.catalog.assets, []);
    const restored = await request('POST', route, first, {folders:[folders[0], missing]});
    assert.equal(restored.status, 200);
    assert.equal(restored.json.linked, 0);
    assert.equal(restored.json.existing, 1);
    assert.equal(restored.json.failed, 1);
    synced = await request('GET', 'catalog/full', second);
    assert.deepEqual(links(synced).map(link => link.folder), [folders[0]]);
    assert.deepEqual(synced.json.catalog.assets.map(cur => cur.id), [asset]);
    assert.deepEqual(new Set(synced.json.catalog.hiddenFolders.map(rule => rule.folder)), new Set(retainedRules));
    assert.ok(visibleFolders(synced.json.catalog).includes(folders[0]));
    assert.ok(!visibleFolders(synced.json.catalog).includes(folders[0]+'/已单独移除'));
    assert.equal((await request('POST', route, first, {folders:[folders[1]]})).json.existing, 1);
    await fs.rmdir(empty);
    assert.equal((await request('POST', refresh, second)).status, 200);
    assert.deepEqual(links(await request('GET', 'catalog/full', second)).map(link => link.folder), [folders[0]]);
    await fs.mkdir(empty);
    assert.equal((await request('POST', refresh, second)).status, 200);
    assert.equal(links(await request('GET', 'catalog/full', second)).length, 2);

    await stopTeamServer(server);
    running = await startTeamServer(database);
    server = running.server;
    request = teamRequest(running.address);
    assert.equal(links(await request('GET', 'catalog/full', second)).length, 2);
    const removed = await request('DELETE', route, second, {folders});
    assert.equal(removed.status, 200);
    assert.equal(removed.json.removed, 2);
    synced = await request('GET', 'catalog/full', first);
    assert.deepEqual(links(synced), []);
    assert.deepEqual(synced.json.catalog.assets.map(cur => cur.id), [asset]);
    assert.equal(await fs.readFile(path.join(source, 'original.obj'), 'utf8'), seed);
    assert.deepEqual(new Set(await fs.readdir(source)), new Set(['original.obj','已单独移除']));
    assert.equal((await fs.stat(empty)).isDirectory(), true);
  } finally {
    await stopTeamServer(server);
    await removeTeamScratch(scratch);
  }
});

test('authenticated heartbeats publish transient online members without changing the catalog revision', {timeout: 20_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-team-test-'));
  const database = path.join(scratch, 'db');
  const cli = async (...args) => (await exec(binary, ['--data', database, ...args], {
    windowsHide: true, encoding: 'utf8',
  })).stdout;
  let server;
  try {
    await cli('init', '在线成员测试', '管理员');
    const first = credentials(await cli('member-add', '美术甲'));
    const second = credentials(await cli('member-add', '美术乙'));
    let running = await startTeamServer(database);
    server = running.server;
    let request = teamRequest(running.address);
    const revision = (await request('GET', 'catalog/full', first)).json.revision;

    assert.equal((await request('POST', 'presence')).status, 401);
    assert.equal((await request('POST', 'presence', second, undefined, {origin: 'https://example.test'})).status, 401);
    const alone = await request('POST', 'presence', first);
    assert.equal(alone.status, 200);
    assert.equal(alone.json.members.length, 1);
    assert.deepEqual(Object.keys(alone.json.members[0]).sort(), ['id', 'lastSeen', 'name', 'onlineSince', 'self']);
    assert.equal(alone.json.members[0].name, '美术甲');
    assert.equal(alone.json.members[0].self, true);

    const both = (await request('POST', 'presence', second)).json.members;
    assert.deepEqual(both.map(({id, self}) => ({id, self})), [
      {id: second.id, self: true}, {id: first.id, self: false},
    ]);
    const refreshed = (await request('POST', 'presence', first)).json.members;
    assert.equal(refreshed[0].onlineSince, alone.json.members[0].onlineSince);
    assert.ok(refreshed[0].lastSeen >= refreshed[0].onlineSince);
    assert.equal((await request('GET', 'catalog/' + revision, first)).json.catalog, null);

    await cli('member-disable', second.id);
    assert.equal((await request('POST', 'presence', second)).status, 401);
    assert.deepEqual((await request('POST', 'presence', first)).json.members.map(({id}) => id), [first.id]);
    const third = credentials(await cli('member-add', '美术丙'));
    await stopTeamServer(server);
    running = await startTeamServer(database);
    server = running.server;
    request = teamRequest(running.address);
    assert.deepEqual((await request('POST', 'presence', third)).json.members.map(({id}) => id), [third.id]);
  } finally {
    await stopTeamServer(server);
    await removeTeamScratch(scratch);
  }
});

test('two members share edits and receive changes detected on the mounted library', {timeout: 65_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-team-test-'));
  const database = path.join(scratch, 'db');
  const mount = path.join(scratch, '共享目录');
  await fs.mkdir(mount);
  const cli = async (...args) => {
    const result = await exec(binary, ['--data', database, ...args], {windowsHide: true, encoding: 'utf8'});
    return result.stdout;
  };
  let server;
  try {
    const admin = credentials(await cli('init', '测试工作室', '管理员'));
    const member = credentials(await cli('member-add', '美术'));
    const running = await startTeamServer(database);
    server = running.server;
    const request = teamRequest(running.address);
    const library = {id: randomUUID(), name: '模型共享库'};
    const relative = '座椅.obj';
    const firstFile = {relativePath: relative, name: '个人目录里的自定义名称', size: 1, modified: 0, tags: ['座椅'], notes: '已有备注'};
    const publication = {library, files: [firstFile], complete: true};
    await fs.writeFile(path.join(mount, relative), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    assert.equal((await request('GET', 'catalog/full')).status, 401);
    assert.equal((await request('POST', 'publish', member, publication)).status, 403);
    assert.equal((await request('POST', 'publish', admin, publication)).status, 200);
    const first = (await request('GET', 'catalog/full', member)).json;
    const asset = first.catalog.assets[0];
    assert.equal(asset.notes, '已有备注');
    assert.equal((await request('PATCH', 'assets/' + asset.id, member, {
      revision: asset.revision, notes: '已审核', tags: ['审核通过'], rating: 4, workflow: 'approved',
    })).status, 200);
    assert.equal((await request('PATCH', 'assets/' + asset.id, admin, {
      revision: asset.revision, notes: '不应写入的旧草稿',
    })).status, 409);
    const changed = (await request('GET', 'catalog/' + first.revision, admin)).json;
    assert.equal(changed.catalog.assets[0].notes, '已审核');
    assert.equal(changed.catalog.assets[0].editedBy, '美术');
    assert.equal(changed.catalog.assets[0].rating, 4);
    assert.equal(changed.catalog.assets[0].workflow, 'approved');
    assert.equal((await request('PATCH', 'assets/' + asset.id, member, {
      revision: changed.catalog.assets[0].revision, rating: 6,
    })).status, 400);
    assert.equal((await request('GET', 'catalog/' + changed.revision, member)).json.catalog, null);
    assert.equal((await request('POST', 'publish', admin, {
      library, files: [{...firstFile, relativePath: '../escape.obj'}], complete: true,
    })).status, 400);
    assert.equal((await request('POST', 'publish', admin, publication)).status, 200);
    assert.equal((await request('GET', 'catalog/full', member)).json.catalog.assets[0].notes, '已审核');

    // Simulate a same-path replacement plus an add and delete while the team service is online.
    const retired = '旧模型.obj';
    await fs.writeFile(path.join(mount, relative), 'v 0 0 0\nv 2 0 0\nv 0 2 0\nf 1 2 3\n# replacement');
    await fs.writeFile(path.join(mount, '新模型.obj'), 'v 0 0 0\n');
    assert.equal((await request('POST', 'publish', admin, {
      library, files: [firstFile, {...firstFile, relativePath: retired}], complete: true,
    })).status, 200);
    await cli('library-watch', library.id, mount);
    const beforeWatch = (await request('GET', 'catalog/full', member)).json;
    assert.equal(beforeWatch.catalog.libraries[0].watching, true);
    let afterWatch;
    for (let tries = 0; tries < 38; tries++) {
      const result = (await request('GET', 'catalog/' + beforeWatch.revision, member)).json;
      if (result.catalog?.assets.some(a => a.relativePath === '新模型.obj')) {
        afterWatch = result.catalog.assets;
        break;
      }
      await delay(1000);
    }
    assert.ok(afterWatch, 'NAS watcher did not publish an automatic update');
    assert.deepEqual(afterWatch.map(a => a.relativePath).sort(), [relative, '新模型.obj'].sort());
    const replaced = afterWatch.find(a => a.relativePath === relative);
    assert.equal(replaced.id, asset.id);
    assert.equal(replaced.notes, '已审核');
    assert.equal(replaced.rating, 4);
    assert.equal(replaced.workflow, 'approved');
    assert.ok(replaced.size > firstFile.size);
    assert.ok(replaced.modified > firstFile.modified);
    assert.equal(Object.hasOwn(replaced, 'path'), false);
    await cli('member-disable', member.id);
    assert.equal((await request('GET', 'catalog/full', member)).status, 401);
  } finally {
    await stopTeamServer(server);
    await removeTeamScratch(scratch);
  }
});

test('address join requires opt-in and creates a regular member only', {timeout: 25_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-team-test-'));
  const database = path.join(scratch, 'db');
  let server;
  try {
    const initialized = await exec(binary, ['--data', database, 'init', '团队测试', '管理员'], {
      windowsHide: true, encoding: 'utf8',
    });
    const admin = credentials(initialized.stdout);

    const closedJoin = await startTeamServer(database);
    server = closedJoin.server;
    const disabled = await teamRequest(closedJoin.address)('POST', 'join', null, {name: '新成员'});
    assert.equal(disabled.status, 404, 'address join must be unavailable by default');
    assert.equal(disabled.json?.token, undefined);
    await stopTeamServer(server);

    const openJoin = await startTeamServer(database, '--allow-address-join');
    server = openJoin.server;
    const request = teamRequest(openJoin.address);
    const origin = await request('POST', 'join', null, {name: '浏览器请求'}, {origin: 'https://example.test'});
    assert.equal(origin.status, 403, 'join must refuse requests with an Origin header');
    assert.equal(origin.json?.token, undefined);
    const joined = await request('POST', 'join', null, {name: '新成员'});
    assert.equal(joined.status, 200);
    assert.ok(/^[a-f0-9]{64}$/.test(joined.json?.token ?? ''), 'join must return a member credential');
    assert.ok(joined.json.token !== admin.token, 'join must not return the administrator credential');

    const library = {id: randomUUID(), name: '共享模型'};
    const files = [{relativePath: '椅子.obj', name: '椅子', size: 12, modified: 1, tags: [], notes: ''}];
    const publication = {library, files, complete: true};
    assert.equal((await request('POST', 'publish', admin, publication)).status, 200);
    const member = {token: joined.json.token};
    const snapshot = await request('GET', 'catalog/full', member);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.json.member.name, '新成员');
    assert.equal(snapshot.json.member.role, 'member');
    assert.equal(snapshot.json.catalog.assets[0].relativePath, '椅子.obj');
    assert.equal((await request('POST', 'publish', member, publication)).status, 403);

    const requestedAdmin = await request('POST', 'join', null, {name: '提升权限', role: 'admin'});
    assert.equal(requestedAdmin.status, 200);
    const role = await request('GET', 'catalog/full', {token: requestedAdmin.json.token});
    assert.equal(role.status, 200);
    assert.equal(role.json.member.role, 'member');
  } finally {
    await stopTeamServer(server);
    await removeTeamScratch(scratch);
  }
});

test('members can immediately sync NAS imports including empty directories', {timeout: 25_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-team-test-'));
  const database = path.join(scratch, 'db');
  const mount = path.join(scratch, '共享素材');
  const empty = path.join(mount, '新目录', '空文件夹');
  const cli = async (...args) => {
    const result = await exec(binary, ['--data', database, ...args], {windowsHide: true, encoding: 'utf8'});
    return result.stdout;
  };
  let server;
  try {
    const admin = credentials(await cli('init', '团队导入', '管理员'));
    const sender = credentials(await cli('member-add', '发送成员'));
    const peer = credentials(await cli('member-add', '第二台电脑'));
    const running = await startTeamServer(database);
    server = running.server;
    const request = teamRequest(running.address);
    const library = {id: randomUUID(), name: 'NAS 素材'};
    const route = 'libraries/' + library.id + '/refresh';
    assert.equal((await request('POST', 'publish', admin, {library, files: [], complete: true})).status, 200);
    assert.equal((await request('POST', route)).status, 401);
    assert.equal((await request('POST', route, sender)).status, 409);

    await fs.mkdir(empty, {recursive: true});
    await cli('library-watch', library.id, mount);
    const baseline = (await request('GET', 'catalog/full', peer)).json;
    await fs.writeFile(path.join(mount, '新目录', '椅子.obj'), 'v 0 0 0\n');
    const [refresh, sharedRefresh] = await Promise.all([
      request('POST', route, sender),
      request('POST', route, peer),
    ]);
    assert.equal(refresh.status, 200);
    assert.equal(sharedRefresh.status, 200);
    assert.ok(refresh.json.revision > baseline.revision);
    const catalog = (await request('GET', 'catalog/' + baseline.revision, peer)).json.catalog;
    assert.deepEqual(catalog.assets.map(asset => asset.relativePath), ['新目录/椅子.obj']);
    assert.deepEqual(catalog.visibleFolders[library.id], ['新目录', '新目录/空文件夹']);

    const hide = {libraryId: library.id, folder: '新目录/空文件夹', hidden: true};
    assert.equal((await request('PATCH', 'folder-visibility', sender, hide)).status, 200);
    assert.deepEqual(
      (await request('GET', 'catalog/full', peer)).json.catalog.visibleFolders[library.id],
      ['新目录'],
    );
    assert.equal((await request('PATCH', 'folder-visibility', sender, {...hide, hidden: false})).status, 200);
    assert.equal((await fs.stat(empty)).isDirectory(), true);
    await fs.rmdir(empty);
    assert.equal((await request('POST', route, sender)).status, 200);
    assert.deepEqual(
      (await request('GET', 'catalog/full', peer)).json.catalog.visibleFolders[library.id],
      ['新目录'],
    );

    await fs.rename(mount, path.join(scratch, '不可用的共享素材'));
    assert.equal((await request('POST', route, sender)).status, 503);
    assert.equal((await request('GET', 'catalog/full', peer)).json.catalog.assets.length, 1);
  } finally {
    await stopTeamServer(server);
    await removeTeamScratch(scratch);
  }
});

test('regular members can synchronise and restore hidden team folders without deleting files', {timeout: 25_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-team-test-'));
  const database = path.join(scratch, 'db');
  const mount = path.join(scratch, 'mount');
  const relative = '家具/草稿/椅子.obj';
  const source = path.join(mount, relative);
  let server;
  try {
    await fs.mkdir(path.dirname(source), {recursive: true});
    await fs.writeFile(source, 'v 0 0 0\n');
    const initialized = await exec(binary, ['--data', database, 'init', '团队工作室', '管理员'], {
      windowsHide: true, encoding: 'utf8',
    });
    const admin = credentials(initialized.stdout);
    let running = await startTeamServer(database, '--allow-address-join');
    server = running.server;
    let request = teamRequest(running.address);
    const joined = await request('POST', 'join', null, {name: '其他电脑'});
    assert.equal(joined.status, 200);
    const member = {token: joined.json.token};
    const joinedPeer = await request('POST', 'join', null, {name: '同步电脑'});
    assert.equal(joinedPeer.status, 200);
    const peer = {token: joinedPeer.json.token};
    const library = {id: randomUUID(), name: '共享模型'};
    const sibling = '家具/草稿预览/封面.png';
    const record = {relativePath: relative, name: '椅子', size: 12, modified: 1, tags: [], notes: '保留备注'};
    const publication = {library, files: [record, {...record, name: '预览', relativePath: sibling}], complete: true};
    assert.equal((await request('POST', 'publish', admin, publication)).status, 200);
    const before = (await request('GET', 'catalog/full', member)).json;
    assert.equal(before.member.role, 'member');
    assert.equal(before.folderVisibility, true);
    assert.equal(before.memberFolderVisibility, true);
    const original = before.catalog.assets.find(asset => asset.relativePath === relative);
    const folder = {libraryId: library.id, folder: '家具/草稿', hidden: true};
    assert.equal((await request('PATCH', 'folder-visibility', null, folder)).status, 401);
    assert.equal((await request('PATCH', 'folder-visibility', member, {...folder, folder: '../外部'})).status, 400);
    const hidden = await request('PATCH', 'folder-visibility', member, folder);
    assert.equal(hidden.status, 200);
    assert.ok(hidden.json.revision > before.revision);
    assert.equal((await request('PATCH', 'folder-visibility', member, folder)).json.revision, hidden.json.revision);

    for (const identity of [admin, member, peer]) {
      const snapshot = (await request('GET', 'catalog/' + before.revision, identity)).json;
      // Legacy clients consume only libraries and assets.
      assert.deepEqual(snapshot.catalog.libraries.map(item => item.id), [library.id]);
      assert.deepEqual(snapshot.catalog.assets.map(asset => asset.relativePath), [sibling]);
      assert.deepEqual(snapshot.catalog.visibleFolders[library.id], ['家具']);
      assert.deepEqual(snapshot.catalog.hiddenFolders, [{libraryId: library.id, folder: folder.folder}]);
    }
    const unchanged = (await request('GET', 'catalog/' + hidden.json.revision, member)).json;
    assert.equal(unchanged.catalog, null);
    assert.equal(unchanged.folderVisibility, true);
    assert.equal(unchanged.memberFolderVisibility, true);
    assert.equal((await request('POST', 'publish', admin, publication)).status, 200);
    assert.deepEqual((await request('GET', 'catalog/full', member)).json.catalog.assets.map(asset => asset.relativePath), [sibling]);

    const root = {...folder, folder: ''};
    const removed = await request('PATCH', 'folder-visibility', member, root);
    assert.equal(removed.status, 200);
    await stopTeamServer(server);
    running = await startTeamServer(database);
    server = running.server;
    request = teamRequest(running.address);
    const persisted = (await request('GET', 'catalog/full', member)).json.catalog;
    assert.deepEqual(persisted.libraries, []);
    assert.deepEqual(persisted.assets, []);
    assert.deepEqual(persisted.allLibraries.map(item => item.id), [library.id]);
    const rootRestore = await request('PATCH', 'folder-visibility', member, {...root, hidden: false});
    assert.equal(rootRestore.status, 200);
    const rootRestored = (await request('GET', 'catalog/' + removed.json.revision, peer)).json;
    assert.equal(rootRestored.member.role, 'member');
    assert.equal(rootRestored.revision, rootRestore.json.revision);
    assert.deepEqual(rootRestored.catalog.assets.map(asset => asset.relativePath), [sibling]);
    const folderRestore = await request('PATCH', 'folder-visibility', member, {...folder, hidden: false});
    assert.equal(folderRestore.status, 200);
    const restored = (await request('GET', 'catalog/' + rootRestore.json.revision, peer)).json.catalog;
    assert.deepEqual(restored.assets.find(asset => asset.relativePath === relative), original);
    assert.equal(await fs.readFile(source, 'utf8'), 'v 0 0 0\n');
  } finally {
    await stopTeamServer(server);
    await removeTeamScratch(scratch);
  }
});
