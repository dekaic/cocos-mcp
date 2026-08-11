'use strict';

var fs = require('fs');
var path = require('path');

function isInside(root, filename) {
    var relative = path.relative(root, filename);
    return relative === '' || (relative.indexOf('..' + path.sep) !== 0 && relative !== '..' && !path.isAbsolute(relative));
}

function resolvePackagePath(packageApi, name) {
    if (name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) return name;
    var list = (packageApi.getPackages() || []).filter(function (pkg) {
        return pkg && (pkg.name === name || (pkg.info && pkg.info.name === name));
    });
    if (!list.length || !list[0].path) {
        throw new Error('找不到扩展 "' + name + '" 的注册路径（getPackages 匹配 ' + list.length + ' 条）');
    }
    return list[0].path;
}

function purgePackageRequireCache(pkgPath, cache, realpathSync) {
    cache = cache || require.cache;
    realpathSync = realpathSync || fs.realpathSync;

    var roots = [path.resolve(pkgPath)];
    try {
        var realRoot = path.resolve(realpathSync(pkgPath));
        if (roots.indexOf(realRoot) < 0) roots.push(realRoot);
    } catch (e) { /* 路径仍以注册值为准 */ }

    var removed = [];
    Object.keys(cache).forEach(function (filename) {
        var absolute = path.resolve(filename);
        if (!roots.some(function (root) { return isInside(root, absolute); })) return;
        delete cache[filename];
        removed.push(filename);
    });
    return removed;
}

module.exports = {
    isInside: isInside,
    resolvePackagePath: resolvePackagePath,
    purgePackageRequireCache: purgePackageRequireCache,
};
