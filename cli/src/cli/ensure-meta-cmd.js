'use strict';
const path = require('path');
const { resourceCommand } = require('./resource-command');
const { makeMeta } = require('../editor/ops/ensure-meta');
const { parseFlags } = require('./flags');

function cmdEnsureMeta(argv) {
  return resourceCommand('ensure_meta', argv, (args, plan) => {
    const { flags, positional } = parseFlags(args);
    if (Object.keys(flags).some(key => key !== 'dry-run') || positional.length !== 1) throw new Error('ensure-meta: expected one file and optional --dry-run');
    const file = path.resolve(positional[0]);
    plan.read(file);
    if (plan.exists(file + '.meta')) return { existing: file + '.meta' };
    const meta = makeMeta(path.extname(file).toLowerCase());
    plan.write(file + '.meta', JSON.stringify(meta, null, 2) + '\n', { create: true });
    return { metaPath: file + '.meta', meta };
  });
}
module.exports = { cmdEnsureMeta };
