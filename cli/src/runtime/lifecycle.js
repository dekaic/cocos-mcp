'use strict';
const path = require('path');
const { createStore } = require('./operations');
const storage = require('./storage');
const { canonicalProject, processIdentity, fault } = require('./identity');

async function executeLifecycle(tool, args, options, execute) {
    const store = options.store || createStore();
    const projectPath = canonicalProject(args.projectPath);
    const { operationId, ...business } = args;
    return store.execute({ projectPath, operationId, tool, args: business,
        target: args.instanceId ? { projectPath, instanceId: args.instanceId } : undefined }, async entry => {
        // Persist intent before spawning/signalling. A crash before the child receipt is not evidence that no child exists.
        storage.publish(path.join(entry.directory, 'lifecycle.json'), { projectPath, action: tool, originalTarget: entry.request.target });
        function child(pid) {
            const owner = processIdentity(pid);
            if (!owner) throw fault('CHILD_IDENTITY_UNAVAILABLE', 'Cannot verify launched process; inspect the project before continuing');
            storage.publish(path.join(entry.directory, 'child.json'), { owner });
            return owner;
        }
        return execute({ ...entry, child });
    }, options);
}
module.exports = { executeLifecycle };
