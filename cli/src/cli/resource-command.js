'use strict';
const path = require('path');
const { parseFlags } = require('./flags');
const { projectForFile, hash } = require('../runtime/identity');
const { runOffline } = require('../runtime/transactions');

// Shared admission for standalone resource commands; the command body only creates an in-memory plan.
function resourceCommand(tool, argv, build) {
    const { flags, positional } = parseFlags(argv);
    if (!positional[0]) throw new Error(tool + ': a resource path is required');
    const first = path.resolve(positional[0]);
    const root = projectForFile(first, flags['project-root'] && path.resolve(flags['project-root']));
    const filtered = [];
    for (let i = 0; i < argv.length; i++) {
        if (['--operation-id', '--project-root'].includes(argv[i])) { i++; continue; }
        filtered.push(argv[i]);
    }
    const inputHash = tool === 'extract_prefab' ? hash(require('fs').readFileSync(first)) : null;
    const result = runOffline(root, tool, { argv: filtered, cwd: process.cwd() }, {
        operationId: flags['operation-id'], dryRun: flags['dry-run'] === true,
        inputHashes: inputHash ? { source: inputHash } : {},
    }, plan => {
        if (inputHash && hash(plan.read(first, null)) !== inputHash) throw require('../runtime/identity').fault('INPUT_CHANGED', 'Input changed before planning; submit the changed input as a new operation');
        return build(filtered, plan);
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result;
}
module.exports = { resourceCommand };
