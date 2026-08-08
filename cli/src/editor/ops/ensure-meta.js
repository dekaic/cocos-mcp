// ensure-meta: 给指定 .ts / .json 文件创建 .meta（如果不存在）
// op: { op:'ensure-meta', path }
//
// 用途：新建 .ts / .ctrl.json 后 cocos 编辑器尚未生成 .meta，但 cli 后续要用
// className → classId 查表（add-component 等）。这时在 add-component 之前插一条
// ensure-meta，主动写一个标准 .meta（v4 uuid + 按扩展名选模板），让 cli 当场能查到表，
// 而不必等 cocos 编辑器异步 import。
//
// 路径规则：path 是绝对路径，或相对项目根（如 'assets/scripts/.../X.ts'）。
// 已存在 .meta 时幂等不动。
// dry-run 时不写盘（让 --dry-run 语义一致）。

'use strict';

const fs = require('fs');
const path = require('path');
const { clearCache } = require('../../classid-resolver.js');
const { deterministicUUID } = require('../../id.js');
const { normalizeOutputSeedPath } = require('../../cli/output-seed.js');

const _META_TEMPLATES = {
  '.ts': (uuid) => ({
    ver: '4.0.24',
    importer: 'typescript',
    imported: true,
    uuid,
    files: [],
    subMetas: {},
    userData: { simulateGlobals: [] },
  }),
  '.json': (uuid) => ({
    ver: '2.0.1',
    importer: 'json',
    imported: true,
    uuid,
    files: ['.json'],
    subMetas: {},
    userData: {},
  }),
};

function _resolveProjectRoot(startPath) {
  let dir = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'assets'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function execEnsureMeta(prefabData, op) {
  if (typeof op.path !== 'string' || op.path.length === 0) {
    throw new Error("ensure-meta: 缺必填字段 'path'");
  }

  let filePath = op.path;
  if (!path.isAbsolute(filePath)) {
    const projectRoot = _resolveProjectRoot(prefabData.resolverStartPath);
    if (!projectRoot) {
      throw new Error(
        `ensure-meta: 无法定位项目根（含 assets/+package.json），请用绝对 path`
      );
    }
    filePath = path.resolve(projectRoot, op.path);
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`ensure-meta: 文件不存在: ${filePath}`);
  }

  const metaPath = filePath + '.meta';
  if (fs.existsSync(metaPath)) {
    // 幂等：已存在不动。但 meta 可能是 Creator/外部在
    // Router 上次扫描后才生成的，必须让同 batch 后续 op 重建索引。
    clearCache();
    return -1;
  }

  const ext = path.extname(filePath).toLowerCase();
  const template = _META_TEMPLATES[ext];
  if (!template) {
    throw new Error(
      `ensure-meta: 不支持的文件扩展名 "${ext}"（当前支持: ${Object.keys(_META_TEMPLATES).join(' / ')}）`
    );
  }

  const meta = template(deterministicUUID(`ensure-meta:${normalizeOutputSeedPath(metaPath)}`));
  if (!Array.isArray(prefabData.plannedExternalChanges)) {
    prefabData.plannedExternalChanges = [];
  }
  prefabData.plannedExternalChanges.push({ action: 'create-meta', path: metaPath, meta });

  if (prefabData.dryRun) return -1;

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  // ensure-meta 是 batch 中少数会立即写盘的 op。先登记回滚，
  // 若后续 op 失败，editPrefab 会删除本次新建的 meta。
  if (!Array.isArray(prefabData.rollbackActions)) {
    prefabData.rollbackActions = [];
  }
  prefabData.rollbackActions.push(() => {
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    clearCache();
  });
  prefabData.externalChanged = true;
  // 同 batch 后续 op（如 add-component）会调 resolveClassIdByName 查表，
  // resolver 有进程内 cache，必须 invalidate 让下次重扫覆盖新建的 meta
  clearCache();
  return -1;
}

module.exports = { execEnsureMeta };
