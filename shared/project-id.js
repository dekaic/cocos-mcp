'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

/**
 * 生成跨进程一致的项目路径。存在的路径会解析符号链接；不存在时仍返回绝对路径，
 * 供 editor_spawn 在项目注册前使用。
 */
function canonicalProjectPath(projectPath) {
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
        throw new Error('projectPath must be a non-empty string');
    }

    var resolved = path.resolve(projectPath);
    try {
        var realpath = fs.realpathSync.native || fs.realpathSync;
        resolved = realpath(resolved);
    } catch (_) {
        // 冷启动时路径可能尚未被 Cocos 注册；绝对路径仍是稳定的退化结果。
    }

    if (process.platform === 'win32') resolved = resolved.toLowerCase();
    return resolved;
}

function projectIdForPath(projectPath) {
    var canonical = canonicalProjectPath(projectPath);
    var digest = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    return 'project_' + digest;
}

module.exports = {
    canonicalProjectPath: canonicalProjectPath,
    projectIdForPath: projectIdForPath,
};
