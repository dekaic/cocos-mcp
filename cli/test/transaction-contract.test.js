'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/runtime/operations');
const { runOffline, recover } = require('../src/runtime/transactions');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-transaction-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const projectPath = path.join(root, 'project');
    fs.mkdirSync(path.join(projectPath, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'package.json'), '{}');
    const a = path.join(projectPath, 'assets', 'a.json');
    const b = path.join(projectPath, 'assets', 'b.json.meta');
    fs.writeFileSync(a, 'before');
    return { projectPath, a, b, store: createStore({ stateRoot: path.join(root, 'state') }) };
}
function execute(f, options = {}) {
    return runOffline(f.projectPath, 'test_write', { value: 'after' }, { store: f.store, operationId: 'write-1', ...options }, plan => {
        plan.write(f.a, 'after'); plan.write(f.b, 'meta', { create: true });
        return { saved: true };
    });
}

for (const staged of [false, true]) {
    for (const externalChange of [false, true]) {
        test(`final verification includes unchanged dependencies (staged=${staged}, external=${externalChange})`, t => {
            const f = fixture(t);
            const before = fs.statSync(f.a, { bigint: true });
            const run = () => runOffline(f.projectPath, 'test_dependency', {}, {
                store: f.store, operationId: 'dependency',
                checkpoint: label => {
                    if (externalChange && label === 'after-publish:0') fs.writeFileSync(f.a, 'external edit');
                },
            }, plan => {
                const bytes = plan.read(f.a);
                if (staged) plan.write(f.a, bytes);
                plan.write(f.b, 'meta', { create: true });
                return {};
            });
            if (!externalChange) {
                assert.equal(run().written, true);
                const after = fs.statSync(f.a, { bigint: true });
                assert.equal(after.ino, before.ino);
                assert.equal(after.mtimeNs, before.mtimeNs);
                assert.equal(fs.readFileSync(f.a, 'utf8'), 'before');
                return;
            }
            assert.throws(run, { code: 'OPERATION_UNKNOWN' });
            const record = f.store.status(f.projectPath, 'dependency');
            assert.equal(record.state, 'unknown');
            assert.equal(record.unresolved, true);
            assert.match(record.message, /Dependency changed before final commit/);
            const failure = JSON.parse(fs.readFileSync(path.join(f.store.operationDirectory(f.projectPath, 'dependency'), 'uncertain.json'), 'utf8'));
            assert.equal(failure.code, 'BASELINE_CONFLICT');
            const directory = path.join(f.store.projectDirectory(f.projectPath), 'transactions', record.transactionId);
            assert.equal(fs.existsSync(path.join(directory, 'COMMITTED.json')), false);
            assert.equal(f.store.pendingTransactions(f.projectPath).length, 1);
            assert.throws(() => f.store.gate(f.projectPath), { code: 'PROJECT_FROZEN' });
            assert.equal(fs.readFileSync(f.b, 'utf8'), 'meta');
            const preview = recover(f.projectPath, record.transactionId, { store: f.store });
            assert.equal(preview.action, 'rollback');
            assert.equal(preview.written, false);
            assert.equal(fs.existsSync(f.b), true);
            const recovery = recover(f.projectPath, record.transactionId, {
                store: f.store, dryRun: false, operationId: 'recover-dependency',
            });
            assert.equal(recovery.action, 'rolled_back');
            assert.equal(fs.existsSync(f.b), false);
            assert.equal(fs.readFileSync(f.a, 'utf8'), 'external edit');
            assert.equal(f.store.status(f.projectPath, 'dependency').unresolved, false);
            assert.equal(f.store.pendingTransactions(f.projectPath).length, 0);
        });
    }
}

test('fixMeta no-op staging retains dependency verification after another meta is published', t => {
    const f = fixture(t);
    const cp = require('node:child_process');
    const git = args => cp.execFileSync('git', ['-C', f.projectPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const unchanged = path.join(f.projectPath, 'assets', 'mode-only.meta');
    const reordered = f.b;
    const head = '{"uuid":"test","userData":{}}\n';
    fs.writeFileSync(unchanged, head, { mode: 0o644 });
    fs.writeFileSync(reordered, head);
    git(['init', '-q']);
    git(['config', 'core.fileMode', 'true']);
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    fs.chmodSync(unchanged, 0o755);
    fs.writeFileSync(reordered, '{"userData":{},"uuid":"test"}\n');
    assert.match(git(['diff', '--name-only']), /mode-only\.meta/);
    assert.equal(fs.readFileSync(unchanged, 'utf8'), git(['show', 'HEAD:assets/mode-only.meta']));
    assert.throws(() => require('../src/editor/fix-meta').fixMeta(f.projectPath, {
        store: f.store, operationId: 'fix-meta-dependency', dryRun: false,
        checkpoint: label => {
            if (label === 'after-publish:0') fs.writeFileSync(unchanged, '{"external":true}\n');
        },
    }), { code: 'OPERATION_UNKNOWN' });
    const record = f.store.status(f.projectPath, 'fix-meta-dependency');
    assert.match(record.message, /Dependency changed before final commit/);
    const directory = path.join(f.store.projectDirectory(f.projectPath), 'transactions', record.transactionId);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'plan.json'), 'utf8'));
    assert.ok(manifest.baselines.some(file => file.file === 'assets/mode-only.meta'));
    assert.deepEqual(manifest.files.map(file => file.file), ['assets/b.json.meta']);
    assert.equal(fs.existsSync(path.join(directory, 'COMMITTED.json')), false);
    assert.equal(fs.readFileSync(reordered, 'utf8'), head);
    assert.equal(fs.readFileSync(unchanged, 'utf8'), '{"external":true}\n');
});
test('ensure-meta followed by add-component resolves virtual metadata without writing during preview', t => {
    const f = fixture(t);
    const file = path.join(f.projectPath, 'assets', 'Example.prefab');
    const script = path.join(f.projectPath, 'assets', 'VirtualComponent.ts');
    fs.copyFileSync(require('./fixture-project').fixturePath, file);
    fs.writeFileSync(script, "@ccclass('VirtualComponent')\nexport class VirtualComponent {}\n");
    const before = fs.readFileSync(file, 'utf8');
    const ops = [{ op: 'ensure-meta', path: script }, { op: 'add-component', node: 'touchArea', componentType: 'VirtualComponent' }];
    const result = require('../src/editor').editPrefab(file, ops, { dryRun: true, projectRoot: f.projectPath });
    assert.equal(result.written, false);
    assert.equal(result.wouldChange, true);
    assert.equal(fs.existsSync(script + '.meta'), false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('preview, meta-only changes, no-op and same-ID retries count resources only', t => {
    const f = fixture(t);
    const preview = execute(f, { dryRun: true, operationId: 'preview-1' });
    assert.equal(preview.written, false);
    assert.equal(preview.changed, false);
    assert.equal(preview.wouldChange, true);
    assert.equal(fs.existsSync(f.b), false);
    assert.throws(() => execute(f, { operationId: 'preview-1' }), { code: 'OPERATION_ID_CONFLICT' });
    const first = execute(f);
    assert.equal(first.written, true);
    assert.throws(() => execute(f, { dryRun: true }), { code: 'OPERATION_ID_CONFLICT' });
    assert.equal(execute(f)._meta.cocosMcp.operationId, 'write-1');
    const noOp = runOffline(f.projectPath, 'test_noop', {}, { store: f.store, operationId: 'noop' }, p => { p.write(f.a, p.read(f.a)); return {}; });
    assert.equal(noOp.written, false);
    assert.equal(f.store.pendingTransactions(f.projectPath).length, 0);
});
for (const point of ['prepared', 'before-publish:0', 'after-publish:0', 'after-publish:1', 'verified', 'committed']) {
    test('durable boundary ' + point + ' preserves commit authority and default-preview recovery', t => {
        const f = fixture(t);
        let error;
        try { execute(f, { checkpoint: label => { if (label === point) throw new Error('injected crash'); } }); }
        catch (e) { error = e; }
        const original = f.store.status(f.projectPath, 'write-1');
        const transactionId = original.transactionId;
        if (point === 'committed') {
            assert.equal(original.state, 'succeeded');
            assert.equal(fs.readFileSync(f.a, 'utf8'), 'after');
            const preview = recover(f.projectPath, transactionId, { store: f.store });
            assert.equal(preview.action, 'committed');
            return;
        }
        assert.ok(error);
        assert.equal(original.state, 'unknown');
        assert.throws(() => f.store.gate(f.projectPath), { code: 'PROJECT_FROZEN' });
        const before = fs.readFileSync(f.a, 'utf8');
        const preview = recover(f.projectPath, transactionId, { store: f.store });
        assert.equal(preview.written, false);
        assert.equal(fs.readFileSync(f.a, 'utf8'), before);
        const restored = recover(f.projectPath, transactionId, { store: f.store, dryRun: false, operationId: 'recover-1' });
        assert.equal(restored.action, 'rolled_back');
        assert.equal(fs.readFileSync(f.a, 'utf8'), 'before');
        assert.equal(fs.existsSync(f.b), false);
        assert.equal(f.store.status(f.projectPath, 'write-1').state, 'unknown');
        assert.equal(f.store.status(f.projectPath, 'write-1').unresolved, false);
        assert.doesNotThrow(() => f.store.gate(f.projectPath));
    });
}
test('recovery preserves external modifications', t => {
    const f = fixture(t);
    assert.throws(() => execute(f, { checkpoint: label => { if (label === 'after-publish:0') throw new Error('crash'); } }));
    const id = f.store.status(f.projectPath, 'write-1').transactionId;
    fs.writeFileSync(f.a, 'external edit');
    assert.throws(() => recover(f.projectPath, id, { store: f.store, dryRun: false, operationId: 'restore-conflict' }), { code: 'RECOVERY_CONFLICT' });
    assert.equal(fs.readFileSync(f.a, 'utf8'), 'external edit');
    assert.throws(() => f.store.gate(f.projectPath), { code: 'PROJECT_FROZEN' });
});

test('recovery retry returns its original success after a later guarded resource write', t => {
    const f = fixture(t);
    assert.throws(() => execute(f, { checkpoint: label => { if (label === 'verified') throw new Error('crash'); } }));
    const id = f.store.status(f.projectPath, 'write-1').transactionId;
    const options = { store: f.store, dryRun: false, operationId: 'recover-1' };
    const first = recover(f.projectPath, id, options);
    const original = f.store.status(f.projectPath, options.operationId);
    assert.equal(first.action, 'rolled_back');
    assert.equal(first.written, true);
    runOffline(f.projectPath, 'later_write', {}, { store: f.store, operationId: 'later-write' }, plan => {
        plan.write(f.a, 'later resource');
        plan.write(f.b, 'later meta', { create: true });
        return {};
    });
    assert.deepEqual(recover(f.projectPath, id, { ...options, checkpoint: () => assert.fail('must not replay recovery') }), first);
    assert.deepEqual(f.store.status(f.projectPath, options.operationId), original);
    // Only the identical request returns history; a new recovery or preview still inspects current resources.
    assert.throws(() => recover(f.projectPath, id, { ...options, operationId: 'new-recovery' }), { code: 'RECOVERY_CONFLICT' });
    assert.throws(() => recover(f.projectPath, id, { store: f.store }), { code: 'RECOVERY_CONFLICT' });
    assert.equal(fs.readFileSync(f.a, 'utf8'), 'later resource');
    assert.equal(fs.readFileSync(f.b, 'utf8'), 'later meta');
    assert.doesNotThrow(() => f.store.gate(f.projectPath));
});

test('recovery retry checks the original fingerprint before loading a different transaction', t => {
    const f = fixture(t);
    assert.throws(() => execute(f, { checkpoint: label => { if (label === 'verified') throw new Error('crash'); } }));
    const id = f.store.status(f.projectPath, 'write-1').transactionId;
    const options = { store: f.store, dryRun: false, operationId: 'recover-1' };
    recover(f.projectPath, id, options);
    const original = f.store.status(f.projectPath, options.operationId);
    const otherId = require('../src/runtime/identity').hash('different transaction');
    assert.throws(() => recover(f.projectPath, otherId, options), { code: 'OPERATION_ID_CONFLICT' });
    assert.deepEqual(f.store.status(f.projectPath, options.operationId), original);
    assert.equal(fs.readFileSync(f.a, 'utf8'), 'before');
    assert.equal(fs.existsSync(f.b), false);
});

test('recovery retry preserves an unknown operation despite later external resource changes', t => {
    const f = fixture(t);
    assert.throws(() => execute(f, { checkpoint: label => { if (label === 'verified') throw new Error('crash'); } }));
    const id = f.store.status(f.projectPath, 'write-1').transactionId;
    const options = { store: f.store, dryRun: false, operationId: 'recover-1' };
    assert.throws(() => recover(f.projectPath, id, { ...options, checkpoint: label => { if (label === 'restored:1') throw new Error('recovery interrupted'); } }), { code: 'OPERATION_UNKNOWN' });
    const original = f.store.status(f.projectPath, options.operationId);
    fs.writeFileSync(f.a, 'external edit');
    assert.throws(() => recover(f.projectPath, id, options), error => {
        assert.equal(error.code, 'OPERATION_UNKNOWN');
        assert.deepEqual(error.operation, original);
        assert.equal(error.operation.state, 'unknown');
        assert.equal(error.operation.unresolved, true);
        return true;
    });
    assert.equal(fs.readFileSync(f.a, 'utf8'), 'external edit');
    assert.throws(() => f.store.gate(f.projectPath), { code: 'PROJECT_FROZEN' });
});

test('formal execution rereads file input bytes after acquiring execution ownership', t => {
    const f = fixture(t);
    const opsFile = path.join(f.projectPath, 'ops.json');
    fs.writeFileSync(opsFile, 'original input');
    const inputHash = require('../src/runtime/identity').hash(fs.readFileSync(opsFile));
    const originalExecute = f.store.executeSync;
    f.store.executeSync = (input, fn, options) => originalExecute(input, entry => {
        fs.writeFileSync(opsFile, 'changed input');
        return fn(entry);
    }, options);
    assert.throws(() => execute(f, { inputFiles: [{ file: opsFile, hash: inputHash }], inputHashes: { ops: inputHash } }), { code: 'INPUT_CHANGED' });
    assert.equal(f.store.status(f.projectPath, 'write-1').state, 'failed');
    assert.equal(fs.readFileSync(f.a, 'utf8'), 'before');
    assert.doesNotThrow(() => f.store.gate(f.projectPath));
});

function crashChild(f, action, point) {
    const source = `const {createStore}=require('./cli/src/runtime/operations');
        const {runOffline,recover}=require('./cli/src/runtime/transactions');
        const [projectPath,a,b,stateRoot,action,point]=JSON.parse(process.argv[1]);
        const store=createStore({stateRoot});
        const checkpoint=label=>{if(label===point) process.exit(86)};
        if(action==='write') runOffline(projectPath,'test_write',{value:'after'},{store,operationId:'write-1',checkpoint},p=>{p.write(a,'after');p.write(b,'meta',{create:true});return {saved:true}});
        else recover(projectPath,store.status(projectPath,'write-1').transactionId,{store,operationId:'recovery-crash',dryRun:false,checkpoint});`;
    const child = require('child_process').spawnSync(process.execPath, ['-e', source, JSON.stringify([f.projectPath, f.a, f.b, f.store.stateRoot, action, point])],
        { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, 86, child.stderr);
}
for (const point of ['plan-persisted', 'backup:0', 'backup:1', 'prepared', 'staged:0', 'before-publish:0', 'published:0', 'after-publish:0', 'staged:1', 'before-publish:1', 'published:1', 'after-publish:1', 'verified', 'committed']) {
    test('OS process exit at ' + point + ' is recoverable without guessing completion', t => {
        const f = fixture(t);
        crashChild(f, 'write', point);
        const original = f.store.status(f.projectPath, 'write-1');
        assert.equal(original.state, point === 'committed' ? 'succeeded' : 'unknown');
        assert.throws(() => f.store.gate(f.projectPath), { code: 'PROJECT_FROZEN' });
        const result = recover(f.projectPath, original.transactionId, { store: f.store, dryRun: false, operationId: 'recover-final' });
        assert.equal(result.action, point === 'committed' ? 'committed' : 'rolled_back');
        assert.equal(fs.readFileSync(f.a, 'utf8'), point === 'committed' ? 'after' : 'before');
        assert.equal(fs.existsSync(f.b), point === 'committed');
        assert.doesNotThrow(() => f.store.gate(f.projectPath));
    });
}
for (const point of ['restored:1', 'restored:0', 'rollback-committed']) {
    test('recovery can itself crash at ' + point + ' and resume through restricted maintenance', t => {
        const f = fixture(t);
        crashChild(f, 'write', 'verified');
        crashChild(f, 'recover', point);
        const id = f.store.status(f.projectPath, 'write-1').transactionId;
        assert.throws(() => f.store.gate(f.projectPath));
        recover(f.projectPath, id, { store: f.store, dryRun: false, operationId: 'recovery-final' });
        assert.equal(fs.readFileSync(f.a, 'utf8'), 'before');
        assert.equal(fs.existsSync(f.b), false);
        assert.doesNotThrow(() => f.store.gate(f.projectPath));
    });
}
test('backup or final-marker corruption preserves diagnostic state and freeze', t => {
    const f = fixture(t);
    crashChild(f, 'write', 'verified');
    const id = f.store.status(f.projectPath, 'write-1').transactionId;
    const dir = path.join(f.store.projectDirectory(f.projectPath), 'transactions', id);
    fs.writeFileSync(path.join(dir, 'backups', '0.json'), JSON.stringify({ hash: 'corrupt', data: 'YmFk' }));
    assert.throws(() => recover(f.projectPath, id, { store: f.store }), { code: 'BACKUP_CORRUPT' });
    require('../src/runtime/storage').publish(path.join(dir, 'COMMITTED.json'), { planHash: 'invented', result: {} });
    assert.throws(() => f.store.gate(f.projectPath), { code: 'TRANSACTION_CORRUPT' });
    assert.equal(fs.readFileSync(f.a, 'utf8'), 'after');
});
test('resolving a transaction does not release an unrelated unknown operation', t => {
    const f = fixture(t);
    crashChild(f, 'write', 'verified');
    f.store.reserve({ projectPath: f.projectPath, operationId: 'unrelated', tool: 'other_mutation' });
    f.store.observe({ projectPath: f.projectPath, operationId: 'unrelated' }, 'transport_unknown');
    const id = f.store.status(f.projectPath, 'write-1').transactionId;
    recover(f.projectPath, id, { store: f.store, dryRun: false, operationId: 'recover-final' });
    assert.throws(() => f.store.gate(f.projectPath), { code: 'PROJECT_FROZEN' });
    assert.throws(() => f.store.reconcile(f.projectPath, 'unrelated', 'accept_current_state', 'Caller says completed'), { code: 'EXECUTION_NOT_STOPPED' });
});
