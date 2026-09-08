'use strict';
const { createRouter } = require('../../bin');
const { createStore } = require('../../../cli/src/runtime/operations');
const registry = require('../../../cli/src/runtime/registry');
let router;
process.on('message', async message => {
    try {
        if (message.kind === 'initialize') {
            router = createRouter({ store: createStore({ stateRoot: message.stateRoot }),
                readRegistry: () => registry.readRegistry(message.registryDirectory) });
            await router.discover();
            process.send({ kind: 'ready' });
        } else {
            process.send({ kind: 'result', result: await router.call(message.name, message.arguments) });
        }
    } catch (error) { process.send({ kind: 'error', code: error.code, message: error.message }); }
});
