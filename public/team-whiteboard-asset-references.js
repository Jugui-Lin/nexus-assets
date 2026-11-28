import {matchingWhiteboardAssetCards} from './whiteboard-asset-uses.js';

const lookupLimit = 8;
const parallelReads = 3;
const projectIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;

function accessLost(error) {
  const message = String(error?.message || error);
  return /团队访问密钥|团队工作空间已切换|请先连接团队|团队服务返回错误 401/.test(message);
}

const networkUnavailable = error => /连接团队服务超时|无法连接团队服务/.test(String(error?.message || error));

function readableProjects(snapshot) {
  if (!Array.isArray(snapshot?.projects)) throw Error('团队白板项目列表暂不可用');
  const projects = new Map();
  for (const project of snapshot.projects) {
    if (typeof project?.id !== 'string' || !projectIdPattern.test(project.id) ||
        typeof project.name !== 'string' || !project.name.trim()) continue;
    projects.set(project.id,{id:project.id,name:project.name.trim()});
  }
  return [...projects.values()];
}

export function initTeamWhiteboardAssetReferences(api) {
  let pending = Promise.resolve();

  async function projectAssetReferences(teamId, projectId, assetId) {
    if (typeof projectId !== 'string' || !projectIdPattern.test(projectId)) throw Error('白板项目无效');
    const snapshot = await api('team_whiteboard_get',{teamId,...(projectId !== 'default' && {projectId})});
    if (!Array.isArray(snapshot?.items)) throw Error('团队白板暂不可用');
    return matchingWhiteboardAssetCards(snapshot.items,assetId);
  }

  async function query({teamId,assetId,preferredProject,stillRequested}) {
    if (!stillRequested()) return {boards:[],note:''};
    let projects;
    try {
      projects = readableProjects(await api('team_whiteboard_projects',{teamId}));
    } catch {
      return {boards:[],note:'暂时无法读取团队白板。'};
    }
    const preferred = projects.find(project => project.id === preferredProject);
    const candidates = (preferred ? [preferred,...projects.filter(project => project !== preferred)] : projects)
      .slice(0,lookupLimit);
    const boards = [];
    let checked = 0;
    for (let index = 0; index < candidates.length && stillRequested(); index += parallelReads) {
      const batch = candidates.slice(index,index + parallelReads);
      const results = await Promise.allSettled(batch.map(project => projectAssetReferences(teamId,project.id,assetId)));
      if (!stillRequested()) return {boards:[],note:''};
      if (results.some(result => result.status === 'rejected' && accessLost(result.reason))) {
        return {boards:[],note:'当前团队白板访问权限已变化，请重新连接后再试。'};
      }
      for (const [position,result] of results.entries()) {
        if (result.status !== 'fulfilled') continue;
        checked++;
        if (result.value.length) boards.push({...batch[position],cards:result.value});
      }
      if (results.every(result => result.status === 'rejected' && networkUnavailable(result.reason))) break;
    }
    if (!stillRequested()) return {boards:[],note:''};
    const coverage = projects.length > lookupLimit ? `，单次最多检查 ${lookupLimit} 个` : '';
    const note = checked < projects.length ? `已检查 ${checked} / ${projects.length} 个团队白板${coverage}。` : '';
    return {boards,note};
  }

  return {
    find(options) {
      const task = pending.then(() => query(options));
      pending = task.catch(() => {});
      return task;
    },
    async projectReferencesAsset(teamId,projectId,assetId,itemId) {
      return (await projectAssetReferences(teamId,projectId,assetId)).some(card => card.itemId === itemId);
    },
  };
}
