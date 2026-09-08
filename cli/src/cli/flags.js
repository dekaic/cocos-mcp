// cli/flags.js — argv 中提取 --key value 形式的选项

'use strict';

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (['dry-run', 'apply', 'with-comps', 'strict', 'debug', 'wait', 'no-login', 'with-login'].includes(key)) {
        flags[key] = true;
        i++;
      } else if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  return { flags, positional };
}

module.exports = { parseFlags };
