// ============================================================
// CC3 Prefab 格式保真写回（纯 CJS，零三方依赖）
// 探测原文件缩进 + 末尾换行字节，minimal-diff 写回
// ============================================================

'use strict';

const { runOffline } = require('./runtime/transactions');
const { projectForFile, contained } = require('./runtime/identity');

function assertFiniteNumbers(value, location = 'data') {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`${location}: 非有限数 ${String(value)} 无法保存为 JSON 数值`);
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assertFiniteNumbers(child, `${location}.${key}`);
    }
  }
}

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
function formatPrefab(data, originalRaw) {
  if (!Array.isArray(data)) {
    throw new Error('writePrefab: data 必须是数组');
  }
  if (typeof originalRaw !== 'string') {
    throw new Error('writePrefab: originalRaw 必须是字符串');
  }

  assertFiniteNumbers(data);
  const indent = detectIndent(originalRaw);
  const trailingNewline = detectTrailingNewline(originalRaw);

  let newRaw = JSON.stringify(data, null, indent);
  if (trailingNewline) {
    newRaw += '\n';
  }

  return newRaw;
}

function writePrefab(filePath, data, originalRaw, options = {}) {
  const projectRoot = projectForFile(filePath, options.projectRoot);
  filePath = contained(projectRoot, filePath);
  return runOffline(projectRoot, 'write_prefab', { filePath, data, originalRaw }, options, plan => {
    plan.write(filePath, formatPrefab(data, originalRaw));
    return {};
  });
}
module.exports = { writePrefab, formatPrefab, detectIndent, detectTrailingNewline, assertFiniteNumbers };
