'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { createStore } = require('../src/runtime/operations');
const identity = require('../src/runtime/identity');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-operation-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const projectPath = path.join(root, 'project');
    fs.mkdirSync(projectPath);
    fs.mkdirSync(path.join(projectPath, 'assets'));
    fs.mkdirSync(path.join(projectPath, 'settings'));
    fs.writeFileSync(path.join(projectPath, 'package.json'), '{}');
    return { root, projectPath, store: createStore({ stateRoot: path.join(root, 'state') }) };
}
function request(projectPath, operationId = crypto.randomUUID()) {
    return { projectPath, operationId, tool: 'scene_set_property', target: { projectPath, instanceId: 'generation-one' }, args: { value: 3 } };
}
function exitDuringExecution(store, req) {
    const child = cp.spawnSync(process.execPath, ['-e', `
        const { createStore } = require(${JSON.stringify(require.resolve('../src/runtime/operations'))});
        const { stateRoot, request } = JSON.parse(process.argv[1]);
        createStore({ stateRoot }).executeSync(request, () => process.exit(0));
    `, JSON.stringify({ stateRoot: store.stateRoot, request: req })], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stdout + child.stderr);
}

test('same ID retries while the executor holds the lock return the original operation, not busy', async t => {
    const { store, projectPath } = fixture(t);
    let complete;
    let calls = 0;
    const req = request(projectPath);
    const first = store.execute(req, async () => { calls++; await new Promise(resolve => { complete = resolve; }); return { saved: true }; });
    const duplicate = await store.execute(req, () => { calls++; });
    assert.equal(duplicate.state, 'running');
    assert.equal(calls, 1);
    await assert.rejects(store.execute({ ...req, args: { value: 4 } }, () => {}), { code: 'OPERATION_ID_CONFLICT' });
    await assert.rejects(store.execute(request(projectPath), () => {}), { code: 'PROJECT_BUSY' });
    complete();
    const result = await first;
    assert.equal(result.state, 'succeeded');
    assert.deepEqual(result.result, { saved: true });
    assert.equal((await store.execute(req, () => { calls++; })).state, 'succeeded');
    assert.equal(calls, 1);
});

test('late Router timeout cannot downgrade executor success or replace original target', async t => {
    const { store, projectPath } = fixture(t);
    const req = request(projectPath);
    await store.execute(req, () => ({ saved: true }));
    store.observe(req, 'transport_unknown');
    assert.equal(store.status(projectPath, req.operationId).state, 'succeeded');
    await assert.rejects(store.execute({ ...req, target: { projectPath, instanceId: 'generation-two' } }, () => {}), { code: 'OPERATION_ID_CONFLICT' });
});

test('unknown freezes business writes and caller prose cannot prove a live executor stopped', async t => {
    const { store, projectPath } = fixture(t);
    const req = request(projectPath);
    await store.execute(req, () => { throw new Error('Scene script result lost'); });
    assert.equal(store.status(projectPath, req.operationId).state, 'unknown');
    await assert.rejects(store.execute(request(projectPath), () => {}), { code: 'PROJECT_FROZEN' });
    assert.throws(() => store.reconcile(projectPath, req.operationId, 'accept_current_state', 'I checked; completed'), { code: 'EXECUTION_NOT_STOPPED' });
    assert.equal(store.status(projectPath, req.operationId).unresolved, true);
});

test('canonical path aliases share the execution guard and do not reenter in one process', async t => {
    const { root, projectPath, store } = fixture(t);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(projectPath, alias);
    assert.equal(identity.canonicalProject(alias), fs.realpathSync(projectPath));
    let finish;
    const first = store.execute(request(projectPath), () => new Promise(resolve => { finish = resolve; }));
    await assert.rejects(store.execute(request(alias), () => {}), { code: 'PROJECT_BUSY' });
    finish({});
    await first;
});

test('service generations own distinct registry files even with identical pid and endpoint', t => {
    const { root, projectPath } = fixture(t);
    const registry = require('../src/runtime/registry');
    const directory = path.join(root, 'editors');
    const first = registry.createRegistration(projectPath, directory);
    const second = registry.createRegistration(projectPath, directory);
    assert.notEqual(first.instanceId, second.instanceId);
    first.publish({ host: '127.0.0.1', port: 7777 });
    second.publish({ host: '127.0.0.1', port: 7777 });
    first.remove();
    const records = registry.readRegistry(directory);
    assert.equal(records.length, 1);
    assert.equal(records[0].instanceId, second.instanceId);
    assert.equal(records[0].url, undefined);
    assert.equal(registry.publicEntry(records[0]).transport, undefined);
    const generationFile = fs.readdirSync(directory).find(name => name.endsWith('.json'));
    fs.copyFileSync(path.join(directory, generationFile), path.join(directory, process.pid + '.json'));
    assert.equal(registry.readRegistry(directory).length, 1, 'PID filenames cannot become generation authority');
    assert.equal(fs.existsSync(path.join(directory, process.pid + '.json')), true);
});

test('reconciliation records the machine stop proof separately from caller disposition', t => {
    const { store, projectPath } = fixture(t);
    const req = request(projectPath);
    store.executeSync(req, () => { throw new Error('injected synchronous failure'); });
    const result = store.reconcile(projectPath, req.operationId, 'accept_current_state', 'I accept the observed resources');
    assert.equal(result.state, 'unknown');
    assert.equal(result.resolution.machineEvidence.executionStopped, true);
    assert.equal(result.resolution.machineEvidence.kind, 'executor_stop_receipt');
    assert.equal(result.resolution.machineEvidence.owner.pid, process.pid);
    assert.ok(result.resolution.machineEvidence.collectedAt);
    assert.equal(result.resolution.callerReport.outcome, 'accept_current_state');
});

test('maintenance cannot replace a live executor lock during its final release', t => {
    const { root } = fixture(t);
    const result = cp.spawnSync(process.execPath, [path.join(__dirname, 'fixtures/lock-release-race.js'), 'parent', root],
        { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.maintenance.error, 'PROJECT_BUSY');
    assert.equal(report.simultaneousExecutors, false);
    assert.equal(report.currentLock.operationId, 'B');
});

test('a stopped synchronous executor releases its own lock but unknown still freezes writes', t => {
    const { store, projectPath } = fixture(t);
    const req = request(projectPath);
    const record = store.executeSync(req, () => { throw new Error('synchronous effects need verification'); });
    assert.equal(record.state, 'unknown');
    assert.equal(record.unresolved, true);
    assert.equal(fs.existsSync(path.join(store.projectDirectory(projectPath), 'execute.json')), false);
    assert.throws(() => store.gate(projectPath), { code: 'PROJECT_FROZEN' });
    const resolved = store.reconcile(projectPath, req.operationId, 'accept_current_state', 'Accept the inspected resources');
    assert.equal(resolved.state, 'unknown');
    assert.equal(resolved.writeGate.allowed, true);
});

test('a residual lock with conflicting process identity is preserved for diagnosis', t => {
    const { store, projectPath } = fixture(t);
    const req = request(projectPath);
    exitDuringExecution(store, req);
    const file = path.join(store.projectDirectory(projectPath), 'execute.json');
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    lock.owner.startId = 'damaged-process-identity';
    fs.writeFileSync(file, JSON.stringify(lock));
    assert.throws(() => store.reconcile(projectPath, req.operationId, 'accept_current_state', 'Caller accepts'), { code: 'LOCK_OWNERSHIP_CONFLICT' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), lock);
});

test('maintenance can dispose an associated lock only after the holder process exits', t => {
    const { store, projectPath } = fixture(t);
    const req = request(projectPath);
    exitDuringExecution(store, req);
    assert.equal(fs.existsSync(path.join(store.projectDirectory(projectPath), 'execute.json')), true);
    const result = store.reconcile(projectPath, req.operationId, 'accept_current_state', 'Accept inspected resources after executor exit');
    assert.equal(result.state, 'unknown');
    assert.equal(result.resolution.machineEvidence.kind, 'process_exit');
    assert.equal(result.writeGate.allowed, true);
    assert.equal(fs.existsSync(path.join(store.projectDirectory(projectPath), 'execute.json')), false);
});

test('a sync executor that dispatches a promise retains its lock without a stop receipt', t => {
    const { store, projectPath } = fixture(t);
    const req = request(projectPath);
    const result = store.executeSync(req, () => Promise.resolve({}));
    assert.equal(result.state, 'unknown');
    assert.equal(fs.existsSync(path.join(store.projectDirectory(projectPath), 'execute.json')), true);
    assert.equal(fs.existsSync(path.join(store.operationDirectory(projectPath, req.operationId), 'stopped.json')), false);
    assert.throws(() => store.reconcile(projectPath, req.operationId, 'accept_current_state', 'Caller says finished'), { code: 'EXECUTION_NOT_STOPPED' });
});

test('a stop receipt does not let maintenance delete a live holder lock after release failure', t => {
    const { store, projectPath } = fixture(t);
    const req = request(projectPath);
    const storage = require('../src/runtime/storage');
    const file = path.join(store.projectDirectory(projectPath), 'execute.json');
    const remove = storage.remove;
    const removal = t.mock.method(storage, 'remove', filename => {
        if (filename === file) throw Object.assign(new Error('injected lock release failure'), { code: 'EIO' });
        return remove(filename);
    });
    assert.throws(() => store.executeSync(req, () => { throw new Error('synchronous effects unknown'); }), { code: 'EIO' });
    removal.mock.restore();
    const lock = storage.read(file);
    assert.ok(storage.read(path.join(store.operationDirectory(projectPath, req.operationId), 'stopped.json')));
    assert.throws(() => store.reconcile(projectPath, req.operationId, 'accept_current_state', 'Caller accepts'), { code: 'PROJECT_BUSY' });
    assert.deepEqual(storage.read(file), lock);
    assert.equal(store.status(projectPath, req.operationId).unresolved, true);
    assert.throws(() => store.gate(projectPath), { code: 'PROJECT_FROZEN' });
});
