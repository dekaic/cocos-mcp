'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const storage = require('./storage');
const identity = require('./identity');
const { transactionState } = require('./transaction-state');
const { fault, hash, stable, canonicalProject, processIdentity, sameProcess } = identity;
const SAFE_FAILURE = Symbol('no-execution-side-effects');

function safeFailure(error) { error[SAFE_FAILURE] = true; return error; }
function createStore(options = {}) {
    const stateRoot = options.stateRoot || path.join(os.homedir(), '.cocos-mcp', 'state');
    const currentOwner = () => ({ ...processIdentity(), token: crypto.randomUUID() });
    function projectDirectory(projectPath) { return path.join(stateRoot, hash(canonicalProject(projectPath))); }
    function operationDirectory(projectPath, operationId) {
        if (typeof operationId !== 'string' || !operationId.trim() || operationId.length > 128) throw fault('OPERATION_ID_REQUIRED', 'operationId must be a nonempty string of at most 128 characters');
        return path.join(projectDirectory(projectPath), 'operations', hash(operationId));
    }
    function descriptor(input) {
        const projectPath = canonicalProject(input.projectPath);
        operationDirectory(projectPath, input.operationId);
        if (typeof input.tool !== 'string' || !input.tool) throw fault('INVALID_OPERATION', 'Underlying tool name is required');
        const target = input.target ? { projectPath: canonicalProject(input.target.projectPath), instanceId: input.target.instanceId } : { projectPath };
        if (target.projectPath !== projectPath) throw fault('TARGET_STALE', 'Operation target belongs to a different project');
        const logical = { tool: input.tool, target, args: input.args || {}, inputHashes: input.inputHashes || {} };
        return { schemaVersion: 1, operationId: input.operationId, projectPath, tool: input.tool, target,
            readOnly: input.readOnly === true,
            args: logical.args, inputHashes: logical.inputHashes,
            fingerprint: hash(JSON.stringify(stable(logical))), expectedExecutor: input.expectedExecutor || null };
    }
    function reserve(input) {
        const request = descriptor(input);
        const directory = operationDirectory(request.projectPath, request.operationId);
        storage.directory(directory);
        const created = storage.publish(path.join(directory, 'request.json'), { ...request,
            submitter: currentOwner(), submissionId: crypto.randomUUID(), submittedAt: new Date().toISOString() });
        const original = storage.read(path.join(directory, 'request.json'));
        if (!original || original.fingerprint !== request.fingerprint || original.readOnly !== request.readOnly) throw fault('OPERATION_ID_CONFLICT', 'operationId is already bound to a different logical request');
        return { created, request: original, directory };
    }
    function observe(input, kind, details = {}) {
        if (!['submitted', 'dispatched', 'transport_unknown'].includes(kind)) throw fault('INVALID_OBSERVATION', 'Router cannot write execution facts');
        const directory = operationDirectory(input.projectPath, input.operationId);
        if (!storage.read(path.join(directory, 'request.json'))) throw fault('OPERATION_NOT_FOUND', 'Operation not found');
        storage.publish(path.join(directory, 'observations', crypto.randomUUID() + '.json'), {
            role: 'router', kind, details, observer: processIdentity(), at: new Date().toISOString(),
        });
    }
    function observations(directory) {
        const folder = path.join(directory, 'observations');
        return fs.existsSync(folder) ? fs.readdirSync(folder).filter(name => name.endsWith('.json')).map(name => storage.read(path.join(folder, name))) : [];
    }
    function readStatus(directory) {
        const request = storage.read(path.join(directory, 'request.json'));
        if (!request) throw fault('STATE_CORRUPT', 'Operation request is missing: ' + directory);
        const execution = storage.read(path.join(directory, 'execution.json'));
        const terminal = storage.read(path.join(directory, 'terminal.json'));
        const rejected = storage.read(path.join(directory, 'rejected.json'));
        const uncertain = storage.read(path.join(directory, 'uncertain.json'));
        const resolution = storage.read(path.join(directory, 'resolution.json'));
        const binding = storage.read(path.join(directory, 'transaction.json'));
        let committed = null;
        let originalWritten = null;
        if (binding) {
            if (!/^[a-f0-9]{64}$/.test(binding.transactionId)) throw fault('STATE_CORRUPT', 'Invalid operation transaction binding');
            const txDirectory = path.join(projectDirectory(request.projectPath), 'transactions', binding.transactionId);
            const appliedDirectory = path.join(txDirectory, 'applied');
            if (fs.existsSync(appliedDirectory) && fs.readdirSync(appliedDirectory).some(file => file.endsWith('.json') && storage.read(path.join(appliedDirectory, file)))) originalWritten = true;
            const tx = transactionState(txDirectory, request.projectPath, binding.transactionId);
            committed = tx.committed;
            if (tx.plan && tx.plan.operationId !== request.operationId) throw fault('STATE_CORRUPT', 'Transaction belongs to another operation');
        }
        const observed = observations(directory);
        if (terminal && !['succeeded', 'failed'].includes(terminal.state)) throw fault('STATE_CORRUPT', 'Invalid executor terminal state: ' + directory);
        let state;
        if (committed) state = 'succeeded';
        else if (terminal) state = terminal.state;
        else if (rejected && !execution) state = 'failed';
        else if (uncertain) state = 'unknown';
        else if (execution) state = sameProcess(execution.owner) ? 'running' : 'unknown';
        else state = observed.some(event => event.kind === 'transport_unknown') || !sameProcess(request.submitter) ? 'unknown' : 'submitted';
        return { operationId: request.operationId, projectPath: request.projectPath, tool: request.tool,
            originalTarget: request.target, state, unresolved: !request.readOnly && !resolution && ['submitted', 'running', 'unknown'].includes(state),
            result: committed ? committed.result : terminal ? terminal.result : rejected ? rejected.result : undefined,
            effects: committed ? committed.effects : terminal ? terminal.effects : rejected || request.readOnly ? { changed: false, written: false } : { changed: null, written: originalWritten },
            transactionId: binding ? binding.transactionId : undefined,
            execution: execution ? { owner: execution.owner, startedAt: execution.startedAt } : null,
            child: storage.read(path.join(directory, 'child.json')),
            message: uncertain ? uncertain.reason : rejected ? rejected.result.message : terminal && terminal.result && terminal.result.message,
            observations: observed, resolution, submittedAt: request.submittedAt };
    }
    function status(projectPath, operationId) {
        if (operationId !== undefined) {
            const directory = operationDirectory(projectPath, operationId);
            if (!fs.existsSync(directory)) throw fault('OPERATION_NOT_FOUND', 'No record for operationId ' + operationId);
            return readStatus(directory);
        }
        const directory = path.join(projectDirectory(projectPath), 'operations');
        if (!fs.existsSync(directory)) return [];
        return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}$/.test(name)).map(name => readStatus(path.join(directory, name)));
    }
    function pendingTransactions(projectPath) {
        const directory = path.join(projectDirectory(projectPath), 'transactions');
        if (!fs.existsSync(directory)) return [];
        return fs.readdirSync(directory).filter(name => !name.startsWith('.')).filter(name => {
            const tx = path.join(directory, name);
            const facts = transactionState(tx, canonicalProject(projectPath), name);
            return !facts.committed && !facts.rolledBack;
        });
    }
    function gate(projectPath, ignoreOperationId) {
        const directory = projectDirectory(projectPath);
        if (maintenanceClaims(projectPath).length) throw fault('PROJECT_BUSY', 'Project is under explicit maintenance or has an unresolved maintenance claim');
        const records = status(projectPath).filter(record => record.operationId !== ignoreOperationId && record.unresolved);
        const unknown = records.filter(record => record.state === 'unknown');
        const transactions = pendingTransactions(projectPath);
        if (unknown.length || transactions.length) throw fault('PROJECT_FROZEN', 'Project has unresolved operations or transactions', { operations: unknown.map(record => record.operationId), transactions });
        const lock = storage.read(path.join(directory, 'execute.json'));
        if (lock && (!lock.operationId || !lock.owner || !sameProcess(lock.owner))) throw fault('PROJECT_FROZEN', 'Execution lock requires explicit ownership reconciliation');
        if (records.some(record => record.state === 'running') || lock) throw fault('PROJECT_BUSY', 'Project already has a conflicting operation', { operations: records.map(record => record.operationId) });
    }
    function acquire(input, owner) {
        const filename = path.join(projectDirectory(input.projectPath), 'execute.json');
        const lock = { operationId: input.operationId, owner };
        if (!storage.publish(filename, lock)) throw fault('PROJECT_BUSY', 'Project execution lock is held');
        return { filename, lock };
    }
    function release(lease) {
        if (!lease) return;
        const current = storage.read(lease.filename);
        if (!current || current.owner.token !== lease.lock.owner.token) throw fault('LOCK_OWNERSHIP_CONFLICT', 'Execution lock ownership changed');
        storage.remove(lease.filename);
    }
    function prepare(input, opts = {}) {
        const entry = reserve(input);
        if (!entry.created) {
            const previous = readStatus(entry.directory);
            // First Router delivery may execute its reserved submission. Public retries never receive a new submission right.
            if (!opts.submissionId || opts.submissionId !== entry.request.submissionId || !['submitted', 'unknown'].includes(previous.state) || previous.resolution || previous.execution) return { previous };
        }
        let lease;
        try {
            if (opts.assertTarget) opts.assertTarget();
            gate(input.projectPath, input.operationId);
            const owner = currentOwner();
            lease = acquire(input, owner);
            if (maintenanceClaims(input.projectPath).length) throw fault('PROJECT_BUSY', 'Maintenance began before execution');
            // The execution lock serializes claim and final gate recheck across processes.
            const others = status(input.projectPath).filter(record => record.operationId !== input.operationId && record.unresolved && record.state !== 'submitted');
            if (others.length || pendingTransactions(input.projectPath).length) throw fault('PROJECT_FROZEN', 'Project state changed before execution');
            if (opts.assertTarget) opts.assertTarget();
            if (!storage.publish(path.join(entry.directory, 'execution.json'), { owner, startedAt: new Date().toISOString() })) {
                release(lease); return { previous: readStatus(entry.directory) };
            }
            return { ...entry, lease, owner };
        } catch (error) {
            if (lease) release(lease);
            storage.publish(path.join(entry.directory, 'rejected.json'), { role: 'admission', result: { code: error.code || 'ADMISSION_FAILED', message: error.message }, at: new Date().toISOString() });
            throw error;
        }
    }
    function finish(entry, state, result, effects) {
        // Serialization is part of result persistence. Failure leaves the operation protected and unknown.
        storage.publish(path.join(entry.directory, 'terminal.json'), { role: 'executor', owner: entry.owner, state, result,
            effects: effects || { changed: result && typeof result.changed === 'boolean' ? result.changed : null,
                written: result && typeof result.written === 'boolean' ? result.written : null }, finishedAt: new Date().toISOString() });
        release(entry.lease);
        return readStatus(entry.directory);
    }
    function failed(entry, error, synchronous) {
        if (storage.read(path.join(entry.directory, 'terminal.json'))) return readStatus(entry.directory);
        if (error[SAFE_FAILURE]) return finish(entry, 'failed', { code: error.code || 'EXECUTION_FAILED', message: error.message,
            ...(error.details ? { blockers: error.details } : {}) }, { changed: false, written: false });
        storage.publish(path.join(entry.directory, 'uncertain.json'), { role: 'executor', owner: entry.owner,
            code: error.code || 'EXECUTION_UNCERTAIN', reason: error.message, at: new Date().toISOString() });
        if (synchronous && error.code !== 'INVALID_EXECUTOR') {
            storage.publish(path.join(entry.directory, 'stopped.json'), { role: 'executor', owner: entry.owner, reason: 'Synchronous execution returned; no asynchronous work was dispatched' });
            release(entry.lease);
        }
        return readStatus(entry.directory);
    }
    async function execute(input, fn, opts) {
        const entry = prepare(input, opts);
        if (entry.previous) return entry.previous;
        try { return finish(entry, 'succeeded', await fn(entry)); }
        catch (error) { return failed(entry, error, false); }
    }
    function executeDetached(input, fn, opts = {}) {
        const entry = prepare(input, opts);
        if (entry.previous) return entry.previous;
        // Completion belongs to the executor, not the response socket. Late completion remains authoritative.
        const timer = setTimeout(() => failed(entry, fault('COMPLETION_UNCONFIRMED', 'Asynchronous completion has not been confirmed'), false), opts.completionTimeoutMs || 120000);
        if (timer.unref) timer.unref();
        Promise.resolve().then(() => fn(entry)).then(result => {
            clearTimeout(timer); finish(entry, 'succeeded', result);
        }, error => { clearTimeout(timer); failed(entry, error, false); }).catch(() => {
            // Persistence errors leave the existing request/claim/lock intact for explicit diagnosis.
        });
        return readStatus(entry.directory);
    }
    function executeSync(input, fn, opts) {
        const entry = prepare(input, opts);
        if (entry.previous) return entry.previous;
        try {
            const result = fn(entry);
            if (result && typeof result.then === 'function') throw fault('INVALID_EXECUTOR', 'Synchronous executor cannot dispatch asynchronous work');
            return finish(entry, 'succeeded', result);
        } catch (error) { return failed(entry, error, true); }
    }
    function preview(input, fn) {
        const entry = reserve({ ...input, readOnly: true });
        if (!entry.created) return readStatus(entry.directory);
        entry.owner = currentOwner();
        storage.publish(path.join(entry.directory, 'execution.json'), { owner: entry.owner, startedAt: new Date().toISOString() });
        try { return finish(entry, 'succeeded', fn()); }
        catch (error) { return failed(entry, safeFailure(error), true); }
    }
    function stopEvidence(directory) {
        const execution = storage.read(path.join(directory, 'execution.json'));
        const receipt = storage.read(path.join(directory, 'stopped.json'));
        const terminal = storage.read(path.join(directory, 'terminal.json'));
        const lifecycle = storage.read(path.join(directory, 'lifecycle.json'));
        const proof = (kind, owner, details = {}) => ({ executionStopped: true, kind, owner, ...details, collectedAt: new Date().toISOString() });
        if (terminal && ['succeeded', 'failed'].includes(terminal.state)) return proof('executor_terminal', execution && execution.owner, { state: terminal.state });
        if (lifecycle) {
            // Router death alone cannot stop a launched Creator, including the spawn/child-receipt crash window.
            if (require('./processes').forProject(lifecycle.projectPath).length) return null;
        }
        const child = storage.read(path.join(directory, 'child.json'));
        if (child && sameProcess(child.owner)) return null;
        const details = { ...(child ? { stoppedChild: child.owner } : {}), ...(lifecycle ? { closedProject: lifecycle.projectPath } : {}) };
        if (execution) {
            if (receipt && receipt.owner && receipt.owner.token === execution.owner.token && receipt.owner.pid === execution.owner.pid && receipt.owner.startId === execution.owner.startId) return proof('executor_stop_receipt', execution.owner, { ...details, receipt });
            return !sameProcess(execution.owner) ? proof('process_exit', execution.owner, details) : null;
        }
        const request = storage.read(path.join(directory, 'request.json'));
        if (request.expectedExecutor) return !sameProcess(request.expectedExecutor) ? proof('expected_executor_exit', request.expectedExecutor, details) : null;
        return !sameProcess(request.submitter) && !observations(directory).some(event => event.kind === 'dispatched') ? proof('submitter_exit_without_delivery', request.submitter, details) : null;
    }
    function maintenanceClaims(projectPath) {
        const folder = path.join(projectDirectory(projectPath), 'maintenance');
        if (!fs.existsSync(folder)) return [];
        return fs.readdirSync(folder).filter(name => name.endsWith('.json')).map(name => ({ filename: path.join(folder, name), lock: storage.read(path.join(folder, name)) }));
    }
    function maintenance(projectPath, operationId, fn) {
        const directory = operationDirectory(projectPath, operationId);
        const record = readStatus(directory);
        const owner = currentOwner();
        const filename = path.join(projectDirectory(projectPath), 'maintenance', owner.token + '.json');
        const lease = { filename, lock: { owner, operationId } };
        if (!storage.publish(filename, lease.lock)) throw fault('PROJECT_FROZEN', 'Maintenance lock is held or requires explicit diagnosis');
        try {
            for (const previous of maintenanceClaims(projectPath).filter(item => item.filename !== filename)) {
                if (!previous.lock || previous.lock.operationId !== operationId || !previous.lock.owner) throw fault('LOCK_OWNERSHIP_CONFLICT', 'Unrelated or corrupt maintenance claim requires explicit diagnosis');
                if (sameProcess(previous.lock.owner)) throw fault('PROJECT_BUSY', 'Another maintainer is still executing');
                // Generation-specific paths cannot be replaced by another maintainer. Reclaim only this proved-dead, associated claim.
                storage.remove(previous.filename);
            }
            const machineEvidence = stopEvidence(directory);
            if (!machineEvidence) throw fault('EXECUTION_NOT_STOPPED', 'Cannot prove the executor stopped; close the exact owning Creator and retry');
            const executionFile = path.join(projectDirectory(projectPath), 'execute.json');
            const lock = storage.read(executionFile);
            if (lock) {
                if (lock.operationId !== operationId) throw fault('LOCK_OWNERSHIP_CONFLICT', 'Maintenance is restricted to the specified operation');
                const execution = storage.read(path.join(directory, 'execution.json'));
                if (!execution || !lock.owner || lock.owner.token !== execution.owner.token ||
                    lock.owner.pid !== execution.owner.pid || lock.owner.startId !== execution.owner.startId) {
                    throw fault('LOCK_OWNERSHIP_CONFLICT', 'Cannot prove ownership and termination of the residual lock');
                }
                // A live owner can still be between its release read and unlink, even after persisting a terminal or stop receipt.
                if (sameProcess(lock.owner)) throw fault('PROJECT_BUSY', 'Execution lock still belongs to a live process; wait for its release or explicitly close the exact owner before retrying');
                // The dead owner cannot perform a delayed release; maintenance blocks new writers until disposition completes.
                storage.remove(executionFile);
                storage.publish(path.join(directory, 'lock-disposition', crypto.randomUUID() + '.json'), { role: 'maintenance', machineEvidence, previousOwner: lock.owner, at: new Date().toISOString() });
            }
            return fn({ directory, record, machineEvidence });
        } finally { release(lease); }
    }
    function executeMaintenanceSync(input, subjectOperationId, fn) {
        const entry = reserve(input);
        if (!entry.created) return readStatus(entry.directory);
        try {
            return maintenance(input.projectPath, subjectOperationId, () => {
                entry.owner = currentOwner();
                storage.publish(path.join(entry.directory, 'execution.json'), { owner: entry.owner, startedAt: new Date().toISOString(), maintenanceSubject: subjectOperationId });
                try { return finish(entry, 'succeeded', fn(entry)); }
                catch (error) { return failed(entry, error, true); }
            });
        } catch (error) {
            storage.publish(path.join(entry.directory, 'rejected.json'), { role: 'admission', result: { code: error.code, message: error.message } });
            throw error;
        }
    }
    function reconcile(projectPath, operationId, outcome, evidence) {
        if (!['accept_current_state', 'confirm_no_effect'].includes(outcome) || typeof evidence !== 'string' || !evidence.trim()) {
            throw fault('INVALID_RECONCILIATION', 'Supply outcome and a nonempty caller evidence report');
        }
        const result = maintenance(projectPath, operationId, ({ directory, machineEvidence }) => {
            const binding = storage.read(path.join(directory, 'transaction.json'));
            if (binding && pendingTransactions(projectPath).includes(binding.transactionId)) throw fault('TRANSACTION_UNRESOLVED', 'Reconcile does not roll back or resolve an unfinished transaction');
            storage.publish(path.join(directory, 'resolution.json'), { role: 'reconciliation', callerReport: { outcome, evidence },
                machineEvidence, at: new Date().toISOString() });
            return readStatus(directory);
        });
        try { gate(projectPath); result.writeGate = { allowed: true, blockers: [] }; }
        catch (error) { result.writeGate = { allowed: false, code: error.code, reason: error.message, blockers: error.details || null }; }
        return result;
    }
    return { stateRoot, projectDirectory, operationDirectory, reserve, observe, status, gate, execute, executeDetached, executeSync, preview, executeMaintenanceSync, maintenance, reconcile, pendingTransactions };
}

module.exports = { createStore, safeFailure };
