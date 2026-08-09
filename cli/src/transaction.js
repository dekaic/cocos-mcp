'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_DIR = path.join(os.tmpdir(), 'cocos-mcp-v3-locks');

function hashContent(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function canonicalFilePath(filePath) {
  const absolute = path.resolve(filePath);
  try {
    const realpath = fs.realpathSync.native || fs.realpathSync;
    return realpath(absolute);
  } catch (_) {
    return absolute;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockPathFor(filePath) {
  const canonical = canonicalFilePath(filePath);
  const digest = hashContent(process.platform === 'win32' ? canonical.toLowerCase() : canonical);
  return path.join(LOCK_DIR, digest + '.lock');
}

function acquireFileLock(filePath) {
  fs.mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
  const lockPath = lockPathFor(filePath);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        filePath: canonicalFilePath(filePath),
        acquiredAt: new Date().toISOString(),
      }), { flag: 'wx', mode: 0o600 });
      return lockPath;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) {}
      if (!holder || !isAlive(holder.pid)) {
        try { fs.unlinkSync(lockPath); } catch (_) {}
        continue;
      }
      const conflict = new Error(
        'prefab file is locked by another cocos-mcp process: pid=' + holder.pid +
        ', file=' + canonicalFilePath(filePath)
      );
      conflict.code = 'E_FILE_LOCKED';
      throw conflict;
    }
  }
  const conflict = new Error('failed to acquire prefab file lock: ' + canonicalFilePath(filePath));
  conflict.code = 'E_FILE_LOCKED';
  throw conflict;
}

function releaseFileLock(lockPath) {
  if (!lockPath) return;
  try {
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (holder && holder.pid === process.pid) fs.unlinkSync(lockPath);
  } catch (_) {}
}

module.exports = {
  acquireFileLock,
  canonicalFilePath,
  hashContent,
  lockPathFor,
  releaseFileLock,
};
