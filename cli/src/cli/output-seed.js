'use strict';

const fs = require('fs');
const path = require('path');

function normalizeOutputSeedPath(outputAbs) {
  let cursor = path.dirname(outputAbs);
  while (true) {
    if (
      fs.existsSync(path.join(cursor, 'package.json')) &&
      fs.existsSync(path.join(cursor, 'assets'))
    ) {
      const relative = path.relative(cursor, outputAbs).split(path.sep).join('/');
      return `project:${relative}`;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return `absolute:${outputAbs.split(path.sep).join('/')}`;
}

module.exports = { normalizeOutputSeedPath };
