// ============================================================
// CC3 Prefab 格式保真写回（纯 CJS，零三方依赖）
// 探测原文件缩进 + 末尾换行字节，minimal-diff 写回
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashContent } = require('./transaction.js');

/**
 * 探测原始文件的缩进单位（空格数）
 * 取所有以空格开头的行中最小缩进数
 * @param {string} raw
 * @returns {number} 缩进空格数，默认 2
 */
function detectIndent(raw) {
  const matches = [...raw.matchAll(/^( +)\S/gm)].map((m) => m[1].length);
  if (matches.length === 0) return 2;
  return Math.min(...matches);
}

/**
 * 探测原始文件末尾是否有换行符
 * @param {string} raw
 * @returns {boolean}
 */
function detectTrailingNewline(raw) {
  return raw.length > 0 && (raw[raw.length - 1] === '\n' || raw[raw.length - 1] === '\r');
}

/**
 * 写回 prefab 文件，保留原始格式（缩进 + 末尾换行）
 *
 * @param {string} filePath         写入目标路径（可与读取路径不同，T7 写临时路径）
 * @param {object[]} data           修改后的 elements 数组
 * @param {string} originalRaw      原始文件内容（用于探测格式）
 */
function writePrefab(filePath, data, originalRaw, options) {
  if (!Array.isArray(data)) {
    throw new Error('writePrefab: data 必须是数组');
  }
  if (typeof originalRaw !== 'string') {
    throw new Error('writePrefab: originalRaw 必须是字符串');
  }

  const opts = options || {};
  const beforeHash = hashContent(originalRaw);
  if (opts.expectedHash && opts.expectedHash !== beforeHash) {
    const expectedConflict = new Error(
      'prefab revision conflict before edit: expected ' + opts.expectedHash + ', actual ' + beforeHash
    );
    expectedConflict.code = 'E_REVISION_CONFLICT';
    throw expectedConflict;
  }

  const currentRaw = fs.readFileSync(filePath, 'utf8');
  const currentHash = hashContent(currentRaw);
  if (currentHash !== beforeHash) {
    const concurrentConflict = new Error(
      'prefab changed while edit was in progress: started at ' + beforeHash + ', now ' + currentHash
    );
    concurrentConflict.code = 'E_REVISION_CONFLICT';
    throw concurrentConflict;
  }

  const indent = detectIndent(originalRaw);
  const trailingNewline = detectTrailingNewline(originalRaw);

  let newRaw = JSON.stringify(data, null, indent);
  if (trailingNewline) {
    newRaw += '\n';
  }

  const afterHash = hashContent(newRaw);
  if (newRaw === currentRaw) return { beforeHash, afterHash, changed: false };

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(
    dir,
    '.' + base + '.cocos-mcp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex') + '.tmp'
  );
  const mode = fs.statSync(filePath).mode;
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx', mode);
    fs.writeFileSync(fd, newRaw, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);

    // 尽力同步目录项；Windows 和部分文件系统不允许打开目录 fd，失败不影响原子替换本身。
    try {
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (_) {}
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }

  return { beforeHash, afterHash, changed: true };
}

module.exports = { writePrefab, detectIndent, detectTrailingNewline };
