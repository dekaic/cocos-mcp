'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const storage = require('../../src/runtime/storage');
const { createStore } = require('../../src/runtime/operations');

const [role, root] = process.argv.slice(2);
const project = path.join(root, 'project');
const marker = name => path.join(root, name);
const store = createStore({ stateRoot: path.join(root, 'state') });
const request = operationId => ({ projectPath: fs.realpathSync(project), operationId, tool: 'fixture_mutation', args: {} });
const pause = new Int32Array(new SharedArrayBuffer(4));
function waitSync(file) {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(file)) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for ' + file);
        Atomics.wait(pause, 0, 0, 20);
    }
}
async function waitFile(file) {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(file)) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for ' + file);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}
function childCall(childRole) {
    return JSON.parse(cp.execFileSync(process.execPath, [__filename, childRole, root], { encoding: 'utf8', timeout: 20000 }));
}
async function main() {
    if (role === 'maintainer') {
        let result;
        try { result = { record: store.reconcile(project, 'A', 'accept_current_state', 'Persisted terminal verified') }; }
        catch (error) { result = { error: error.code, message: error.message }; }
        console.log(JSON.stringify({ pid: process.pid, ...result }));
        return;
    }
    if (role === 'contender') {
        let entered = false;
        let code;
        try { store.executeSync(request('during-A-release'), () => { entered = true; return {}; }); }
        catch (error) { code = error.code; }
        console.log(JSON.stringify({ entered, code }));
        return;
    }
    const lockFile = path.join(store.projectDirectory(project), 'execute.json');
    if (role === 'B') {
        const publish = storage.publish;
        const claim = path.join(store.operationDirectory(project, 'B'), 'execution.json');
        storage.publish = function (file, ...args) {
            if (file === claim) {
                fs.writeFileSync(marker('b-after-final-checks'), 'ready');
                waitSync(marker('b-continue'));
            }
            return publish(file, ...args);
        };
        const record = await store.execute(request('B'), async () => {
            fs.writeFileSync(marker('b-executing'), 'true');
            await waitFile(marker('b-finish'));
            return { changed: false, written: false };
        });
        fs.writeFileSync(marker('b-result.json'), JSON.stringify(record));
        return;
    }

    let child;
    let maintenance;
    let contender;
    let intercepted = false;
    function startB() {
        child = cp.spawn(process.execPath, [__filename, 'B', root], { stdio: ['ignore', 'inherit', 'inherit'] });
        waitSync(marker('b-after-final-checks'));
    }
    const read = storage.read;
    storage.read = function (file) {
        const value = read(file);
        if (file === lockFile && value && value.operationId === 'A' && !intercepted &&
            fs.existsSync(path.join(store.operationDirectory(project, 'A'), 'terminal.json'))) {
            intercepted = true;
            // The real maintainer runs after A read its lock, before A unlinks it.
            maintenance = childCall('maintainer');
            if (maintenance.error) {
                assert.equal(maintenance.error, 'PROJECT_BUSY');
                assert.deepEqual(read(file), value, 'Maintenance must leave the live owner lock unchanged');
                contender = childCall('contender');
                assert.deepEqual(contender, { entered: false, code: 'PROJECT_BUSY' });
            } else startB(); // Vulnerable implementation: B now owns the path that A will unlink.
        }
        return value;
    };
    let a;
    try { a = store.executeSync(request('A'), () => ({ changed: false, written: false })); }
    finally { storage.read = read; }
    assert.equal(intercepted, true, 'The release timing barrier must be reached');
    assert.equal(a.state, 'succeeded');
    const lockAfterARelease = read(lockFile);
    if (!child) startB();
    let finishC;
    let cError;
    const cPromise = store.execute(request('C'), () => new Promise(resolve => { finishC = resolve; }))
        .catch(error => { cError = error.code; });
    fs.writeFileSync(marker('b-continue'), 'continue');
    await waitFile(marker('b-executing'));
    const report = { stateRoot: root, maintenance, contender, lockAfterARelease,
        records: store.status(project).map(record => ({ operationId: record.operationId, state: record.state, execution: record.execution })),
        currentLock: read(lockFile), cError,
        simultaneousExecutors: ['B', 'C'].every(id => store.status(project, id).state === 'running') };
    fs.writeFileSync(marker('result.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(marker('b-finish'), 'finish');
    await waitFile(marker('b-result.json'));
    if (finishC) finishC({ changed: false, written: false });
    await cPromise;
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    console.log(JSON.stringify(report));
    assert.equal(report.simultaneousExecutors, false, 'Old release must not delete the next execution lock');
    assert.equal(report.cError, 'PROJECT_BUSY');
    assert.equal(report.currentLock.operationId, 'B');
    store.gate(project);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
