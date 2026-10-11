'use strict';
const fs = require('fs');
const path = require('path');
const { hash, canonicalProject, contained, fault } = require('./identity');
const storage = require('./storage');
const { createStore, safeFailure } = require('./operations');
const { createPlan, readDisk } = require('./plan');
const { assertClosed } = require('./processes');
const { transactionState } = require('./transaction-state');

function unwrap(record) {
    if (record.state === 'succeeded') return { ...record.result, _meta: { ...(record.result && record.result._meta), cocosMcp: {
        operationId: record.operationId, projectPath: record.projectPath, state: record.state, transactionId: record.transactionId } } };
    throw Object.assign(fault(record.state === 'failed' ? record.result.code : 'OPERATION_UNKNOWN',
        record.state === 'failed' ? record.result.message : 'Operation has not been confirmed complete; query the same operationId, do not replay with a new ID'), { operation: record });
}
function txPath(store, projectPath, transactionId) {
    if (typeof transactionId !== 'string' || !/^[a-f0-9]{64}$/.test(transactionId)) throw fault('INVALID_TRANSACTION', 'Invalid transactionId');
    return path.join(store.projectDirectory(projectPath), 'transactions', transactionId);
}
function stageFile(filename, bytes, mode) {
    const fd = fs.openSync(filename, 'wx', mode);
    try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    storage.syncDirectory(path.dirname(filename));
}
function publishResource(file, temporary, expectedHash) {
    if (readDisk(file).hash !== expectedHash) throw fault('BASELINE_CONFLICT', 'Resource changed before publication: ' + file);
    if (expectedHash === null) fs.linkSync(temporary, file); // Atomic no-overwrite publication; not copyFile.
    else fs.renameSync(temporary, file);
    storage.syncDirectory(path.dirname(file));
}
function describe(plan, result, dryRun) {
    const changes = plan.changes();
    return { ...result, dryRun, changed: dryRun ? false : changes.length > 0, written: dryRun ? false : changes.length > 0,
        wouldChange: changes.length > 0, resources: changes.map(change => ({ filePath: change.file,
            beforeHash: change.before.hash, afterHash: hash(change.after), created: change.before.hash === null })) };
}
function commit(store, entry, plan, result, checkpoint) {
    const changes = plan.changes();
    plan.verifyBaseline();
    if (!changes.length) return result;
    const transactionId = hash(entry.request.operationId);
    const directory = txPath(store, plan.root, transactionId);
    storage.directory(directory);
    storage.publish(path.join(entry.directory, 'transaction.json'), { transactionId });
    const files = changes.map((change, index) => ({ file: path.relative(plan.root, change.file), beforeHash: change.before.hash,
        afterHash: hash(change.after), mode: change.before.mode,
        temporary: path.basename(change.file) + '.cocos-mcp-' + transactionId + '-' + index,
        backup: index + '.json' }));
    const manifest = { schemaVersion: 1, projectPath: plan.root, operationId: entry.request.operationId, transactionId, files,
        baselines: [...plan.baseline].map(([file, before]) => ({ file: path.relative(plan.root, file), hash: before.hash })), result };
    storage.publish(path.join(directory, 'plan.json'), manifest);
    checkpoint('plan-persisted');
    for (let index = 0; index < changes.length; index++) {
        const change = changes[index];
        storage.publish(path.join(directory, 'backups', index + '.json'), {
            hash: change.before.hash, data: change.before.bytes === null ? null : change.before.bytes.toString('base64') });
        checkpoint('backup:' + index);
    }
    storage.publish(path.join(directory, 'READY.json'), { planHash: hash(JSON.stringify(manifest)) });
    checkpoint('prepared');
    for (let index = 0; index < changes.length; index++) {
        const change = changes[index];
        if (plan.filename(change.file) !== change.file) throw fault('BASELINE_CONFLICT', 'Resource path changed before publication');
        const temporary = path.join(path.dirname(change.file), files[index].temporary);
        stageFile(temporary, change.after, change.before.mode);
        checkpoint('staged:' + index);
        storage.publish(path.join(directory, 'started', index + '.json'), { file: files[index].file });
        checkpoint('before-publish:' + index);
        publishResource(change.file, temporary, change.before.hash);
        checkpoint('published:' + index);
        storage.publish(path.join(directory, 'applied', index + '.json'), { hash: hash(change.after) });
        checkpoint('after-publish:' + index);
        if (fs.existsSync(temporary)) storage.remove(temporary);
    }
    for (const change of changes) {
        if (readDisk(change.file).hash !== hash(change.after)) throw fault('BASELINE_CONFLICT', 'Resource changed before final commit: ' + change.file);
    }
    const changedFiles = new Set(changes.map(change => change.file));
    for (const [file, before] of plan.baseline) {
        if (plan.filename(file) !== file || !changedFiles.has(file) && readDisk(file).hash !== before.hash) throw fault('BASELINE_CONFLICT', 'Dependency changed before final commit: ' + file);
    }
    checkpoint('verified');
    storage.publish(path.join(directory, 'COMMITTED.json'), { planHash: hash(JSON.stringify(manifest)),
        committedAt: new Date().toISOString(), result, effects: { changed: true, written: true } });
    checkpoint('committed');
    // Recovery backups remain available. Retention is deliberate; no automatic destructive cleanup policy.
    return result;
}
function runOffline(projectPath, tool, args, options, build) {
    options = options || {};
    if (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') throw fault('INVALID_ARGUMENTS', 'dryRun must be a boolean');
    const project = canonicalProject(projectPath);
    function planNow() {
        for (const input of options.inputFiles || []) {
            if (hash(fs.readFileSync(input.file)) !== input.hash) throw fault('INPUT_CHANGED', 'Input changed before planning: ' + input.file);
        }
        const plan = createPlan(project);
        const result = plan.run(() => build(plan));
        return { plan, result: describe(plan, result, options.dryRun === true) };
    }
    if (options.dryRun === true) {
        if (!options.operationId) return planNow().result;
        const previewStore = options.store || createStore();
        return unwrap(previewStore.preview({ projectPath: project, operationId: options.operationId, tool,
            args: { ...args, dryRun: true }, inputHashes: options.inputHashes }, () => planNow().result));
    }
    const store = options.store || createStore();
    const record = store.executeSync({ projectPath: project, operationId: options.operationId, tool,
        args: { ...args, dryRun: false }, inputHashes: options.inputHashes }, entry => {
        let prepared;
        try { assertClosed(project); prepared = planNow(); prepared.plan.verifyBaseline(); assertClosed(project); }
        catch (error) { throw safeFailure(error); }
        return commit(store, entry, prepared.plan, prepared.result, options.checkpoint || (() => {}));
    });
    return unwrap(record);
}
function loadTransaction(store, projectPath, transactionId) {
    const directory = txPath(store, projectPath, transactionId);
    const facts = transactionState(directory, canonicalProject(projectPath), transactionId);
    const plan = facts.plan;
    if (!plan || plan.transactionId !== transactionId || plan.projectPath !== canonicalProject(projectPath) || !Array.isArray(plan.files)) {
        throw fault('TRANSACTION_CORRUPT', 'Transaction plan is missing or invalid; preserve the directory for explicit diagnosis');
    }
    const committed = facts.committed;
    const ready = storage.read(path.join(directory, 'READY.json'));
    const expectedHash = hash(JSON.stringify(plan));
    if ((committed && committed.planHash !== expectedHash) || (ready && ready.planHash !== expectedHash)) throw fault('TRANSACTION_CORRUPT', 'Transaction record hash does not match plan');
    const files = plan.files.map((file, index) => {
        if (!file || typeof file.file !== 'string' || path.isAbsolute(file.file) || file.backup !== index + '.json' ||
            file.temporary !== path.basename(file.file) + '.cocos-mcp-' + transactionId + '-' + index ||
            (file.beforeHash !== null && !/^[a-f0-9]{64}$/.test(file.beforeHash)) || !/^[a-f0-9]{64}$/.test(file.afterHash)) throw fault('TRANSACTION_CORRUPT', 'Invalid transaction resource descriptor');
        const absolute = contained(plan.projectPath, path.resolve(plan.projectPath, file.file));
        if (absolute !== path.resolve(plan.projectPath, file.file)) throw fault('RECOVERY_CONFLICT', 'Resource path identity changed');
        const before = storage.read(path.join(directory, 'backups', file.backup));
        // An incomplete backup phase cannot have published resources. Do not guess if READY is durable.
        if (!before && ready) throw fault('BACKUP_CORRUPT', 'Required recovery backup is missing: ' + file.file);
        if (before && (before.hash !== file.beforeHash || (before.data === null ? null : hash(Buffer.from(before.data, 'base64'))) !== file.beforeHash)) {
            throw fault('BACKUP_CORRUPT', 'Recovery backup failed verification: ' + file.file);
        }
        const currentHash = readDisk(absolute).hash;
        if (facts.rolledBack && currentHash !== file.beforeHash) throw fault('RECOVERY_CONFLICT', 'Resource changed after the completed rollback: ' + absolute);
        if (!committed && currentHash !== file.beforeHash && currentHash !== file.afterHash) throw fault('RECOVERY_CONFLICT', 'External resource changes prevent automatic recovery: ' + absolute);
        const started = storage.read(path.join(directory, 'started', index + '.json'));
        const applied = storage.read(path.join(directory, 'applied', index + '.json'));
        if (!committed && (!ready || !started) && currentHash !== file.beforeHash) throw fault('RECOVERY_CONFLICT', 'A resource that this transaction never published has changed: ' + absolute);
        return { ...file, absolute, before, currentHash, started, applied };
    });
    return { directory, plan, committed, files, rolledBack: facts.rolledBack };
}
function recover(projectPath, transactionId, options = {}) {
    if (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') throw fault('INVALID_ARGUMENTS', 'dryRun must be a boolean');
    const project = canonicalProject(projectPath);
    const store = options.store || createStore();
    txPath(store, project, transactionId); // Validate the ID without reading mutable transaction/resource state.
    const input = { projectPath: project, operationId: options.operationId,
        tool: 'offline_recover', args: { transactionId, dryRun: false } };
    if (options.dryRun === false && storage.read(path.join(store.operationDirectory(project, options.operationId), 'request.json'))) {
        // A retry observes its original execution, even if resources changed after that execution.
        store.reserve(input); // Verify the immutable fingerprint; this grants no execution right.
        return unwrap(store.status(project, options.operationId));
    }
    let tx = loadTransaction(store, project, transactionId);
    function preview() {
        return { transactionId, action: tx.committed ? 'committed' : tx.rolledBack ? 'rolled_back' : 'rollback',
            dryRun: true, changed: false, written: false,
            wouldChange: !tx.committed && tx.files.some(file => file.currentHash !== file.beforeHash),
            originalOperationId: tx.plan.operationId,
            resources: tx.files.map(file => ({ filePath: file.absolute, currentHash: file.currentHash, beforeHash: file.beforeHash, committedHash: tx.committed ? file.afterHash : undefined })) };
    }
    if (options.dryRun !== false) return preview();
    const result = store.executeMaintenanceSync(input, tx.plan.operationId, entry => {
        assertClosed(project);
        tx = loadTransaction(store, project, transactionId);
        const checkpoint = options.checkpoint || (() => {});
        if (tx.committed) {
            storage.publish(path.join(store.operationDirectory(project, tx.plan.operationId), 'terminal.json'), {
                role: 'transaction-recovery', state: 'succeeded', result: tx.committed.result, effects: tx.committed.effects,
                machineEvidence: { committedPlanHash: tx.committed.planHash } });
            return { ...preview(), dryRun: false, recoveredResult: tx.committed.result };
        }
        let written = false;
        for (let index = tx.files.length - 1; index >= 0; index--) {
            const file = tx.files[index];
            if (contained(project, file.absolute) !== file.absolute) throw fault('RECOVERY_CONFLICT', 'Resource path changed during recovery');
            const current = readDisk(file.absolute).hash;
            if (current !== file.beforeHash && current !== file.afterHash) throw fault('RECOVERY_CONFLICT', 'Resource changed during recovery: ' + file.absolute);
            if (current !== file.beforeHash) {
                if (!file.before) throw fault('BACKUP_CORRUPT', 'Cannot restore without a verified backup');
                const temporary = path.join(path.dirname(file.absolute), file.temporary + '-restore-' + hash(options.operationId).slice(0, 12));
                if (file.beforeHash === null) storage.remove(file.absolute);
                else {
                    // A previous interrupted attempt may own a verified stage at this generation-specific path.
                    if (fs.existsSync(temporary)) {
                        if (readDisk(temporary).hash !== file.beforeHash) throw fault('RECOVERY_CONFLICT', 'Conflicting recovery staging file');
                        storage.remove(temporary);
                    }
                    stageFile(temporary, Buffer.from(file.before.data, 'base64'), file.mode);
                    publishResource(file.absolute, temporary, current);
                    if (fs.existsSync(temporary)) storage.remove(temporary);
                }
                written = true;
            }
            storage.publish(path.join(tx.directory, 'restored', index + '.json'), { hash: file.beforeHash });
            checkpoint('restored:' + index);
            const stage = path.join(path.dirname(file.absolute), file.temporary);
            if (fs.existsSync(stage)) {
                if (readDisk(stage).hash !== file.afterHash) throw fault('RECOVERY_CONFLICT', 'Conflicting transaction staging file');
                storage.remove(stage);
            }
        }
        for (const file of tx.files) if (readDisk(file.absolute).hash !== file.beforeHash) throw fault('RECOVERY_CONFLICT', 'Rollback verification failed');
        const historyWritten = tx.files.some(file => file.applied) ? true : tx.files.some(file => file.started) ? null : false;
        const facts = { action: 'rolled_back', transactionId, planHash: hash(JSON.stringify(tx.plan)), recoveryOperationId: entry.request.operationId, changed: written, written,
            originalWritten: historyWritten, restoredAt: new Date().toISOString() };
        storage.publish(path.join(tx.directory, 'ROLLED_BACK.json'), facts);
        checkpoint('rollback-committed');
        storage.publish(path.join(store.operationDirectory(project, tx.plan.operationId), 'resolution.json'), {
            role: 'recovery', machineEvidence: { executionStopped: true, transactionId, rolledBack: true }, originalWritten: historyWritten });
        // A crashed earlier maintenance attempt is not an independent business operation. Resolve only proved-stopped attempts for this transaction.
        for (const record of store.status(project)) {
            if (record.operationId === entry.request.operationId || record.tool !== 'offline_recover' || !record.unresolved) continue;
            const request = storage.read(path.join(store.operationDirectory(project, record.operationId), 'request.json'));
            const stopped = storage.read(path.join(store.operationDirectory(project, record.operationId), 'stopped.json'));
            const provenStopped = record.execution && (!require('./identity').sameProcess(record.execution.owner) || stopped && stopped.owner.token === record.execution.owner.token);
            if (request && request.args.transactionId === transactionId && provenStopped) storage.publish(path.join(store.operationDirectory(project, record.operationId), 'resolution.json'), { role: 'recovery', machineEvidence: { transactionId, rolledBack: true, executionStopped: true } });
        }
        return facts;
    });
    return unwrap(result);
}
module.exports = { runOffline, recover, loadTransaction, unwrap };
