'use strict';
const path = require('path');
const { randomUUID } = require('crypto');
const { currentPlan } = require('../../runtime/plan');
const { fault } = require('../../runtime/identity');

function makeMeta(ext, uuid = randomUUID()) {
  if (ext === '.ts' || ext === '.js') return {
    ver: '4.0.24', importer: 'typescript', imported: true, uuid, files: [], subMetas: {}, userData: { simulateGlobals: [] },
  };
  if (ext === '.json') return {
    ver: '2.0.1', importer: 'json', imported: true, uuid, files: ['.json'], subMetas: {}, userData: {},
  };
  throw new Error('ensure-meta: unsupported extension ' + ext);
}
function execEnsureMeta(prefabData, op) {
  if (typeof op.path !== 'string' || !op.path) throw new Error("ensure-meta: missing path");
  const plan = currentPlan();
  if (!plan) throw fault('EXECUTION_CONTEXT_REQUIRED', 'ensure-meta must run inside the offline planner');
  const filePath = path.isAbsolute(op.path) ? op.path : path.resolve(plan.root, op.path);
  plan.read(filePath); // Dependency baseline, not a filesystem existence promise.
  if (plan.exists(filePath + '.meta')) return -1;
  plan.write(filePath + '.meta', JSON.stringify(makeMeta(path.extname(filePath).toLowerCase()), null, 2) + '\n', { create: true });
  return -1;
}
module.exports = { execEnsureMeta, makeMeta };
