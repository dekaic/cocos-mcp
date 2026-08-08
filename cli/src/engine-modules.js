'use strict';

const fs = require('fs');
const path = require('path');

function findProjectRoot(startPath) {
  let cursor = fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath);
  while (true) {
    if (fs.existsSync(path.join(cursor, 'package.json')) && fs.existsSync(path.join(cursor, 'assets'))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function getEngineModuleState(startPath, moduleName) {
  const projectRoot = findProjectRoot(startPath);
  if (!projectRoot) return { projectRoot: null, enabled: null };
  const configPath = path.join(projectRoot, 'settings', 'v2', 'packages', 'engine.json');
  if (!fs.existsSync(configPath)) return { projectRoot, enabled: null };

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const modules = config.modules || {};
    const configKey = modules.globalConfigKey || 'defaultConfig';
    const current = modules.configs && modules.configs[configKey];
    if (!current) return { projectRoot, enabled: null };
    if (Array.isArray(current.includeModules)) {
      return { projectRoot, enabled: current.includeModules.includes(moduleName) };
    }
    const cached = current.cache && current.cache[moduleName];
    return { projectRoot, enabled: cached && typeof cached._value === 'boolean' ? cached._value : null };
  } catch (_) {
    return { projectRoot, enabled: null };
  }
}

function warnForAnimationModule(animPath) {
  const state = getEngineModuleState(animPath, 'animation');
  if (state.enabled === false) {
    process.stderr.write(
      'Warning: Cocos engine module "animation" is disabled. The .anim JSON can be valid and import successfully, ' +
      'but a release build may fail to deserialize cc.AnimationClip with Error 5302. ' +
      'Enable Animation in Creator Project Settings > Feature Cropping before runtime validation.\n'
    );
  }
  return state;
}

module.exports = { findProjectRoot, getEngineModuleState, warnForAnimationModule };
