#!/usr/bin/env node
'use strict';

require('../src/index.js'); // 确保模块可正常加载
const { main } = require('../src/cli/main.js');

main(process.argv.slice(2)).catch(error => {
    process.stderr.write(JSON.stringify({ code: error.code || 'COMMAND_FAILED', message: error.message, operation: error.operation }, null, 2) + '\n');
    process.exitCode = 1;
});
