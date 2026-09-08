'use strict';
const path = require('path');
const storage = require('./storage');
const { hash, fault } = require('./identity');

// Commit/rollback markers are facts only when bound to the complete durable plan.
function transactionState(directory, projectPath, transactionId) {
    if (!/^[a-f0-9]{64}$/.test(transactionId)) throw fault('TRANSACTION_CORRUPT', 'Invalid transaction directory: ' + directory);
    const plan = storage.read(path.join(directory, 'plan.json'));
    const committed = storage.read(path.join(directory, 'COMMITTED.json'));
    const rolledBack = storage.read(path.join(directory, 'ROLLED_BACK.json'));
    if (plan && (plan.schemaVersion !== 1 || plan.projectPath !== projectPath || plan.transactionId !== transactionId ||
        typeof plan.operationId !== 'string' || hash(plan.operationId) !== transactionId || !Array.isArray(plan.files))) {
        throw fault('TRANSACTION_CORRUPT', 'Transaction plan identity mismatch: ' + directory);
    }
    const planHash = plan && hash(JSON.stringify(plan));
    if ((committed || rolledBack) && !plan || committed && rolledBack ||
        committed && (committed.planHash !== planHash || committed.result === undefined || plan.result === undefined || hash(JSON.stringify(committed.result)) !== hash(JSON.stringify(plan.result)) ||
            committed.effects?.changed !== true || committed.effects?.written !== true) ||
        rolledBack && (rolledBack.planHash !== planHash || rolledBack.transactionId !== transactionId || rolledBack.action !== 'rolled_back')) {
        throw fault('TRANSACTION_CORRUPT', 'Invalid final transaction fact; preserve the state for diagnosis: ' + directory);
    }
    return { plan, committed, rolledBack, planHash };
}
module.exports = { transactionState };
