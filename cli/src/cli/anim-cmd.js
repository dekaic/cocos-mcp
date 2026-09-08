// cli/anim-cmd.js — anim 子命令
//
// .anim 文件与 prefab 同为 JSON 数组 + __id__ 引用容器，但资产头不同。
// query 使用 AnimationClip 专用解析器；legacy batch 仍只承载原 prefab op 包装。
//
// 用法：
//   anim query <anim> [--selector tree]
//   anim batch <anim> <ops.json> [--dry-run]
//
// 注意：op 库面向 cc.Node 树，不提供 AnimationClip 曲线编辑。
// 新建数值曲线使用 router 的 animation_create 或 createAnimationClip API。

'use strict';

const fs = require('fs');
const path = require('path');
const { editPrefab } = require('../editor/index.js');
const { queryAnimationClip } = require('../animation.js');
const { parseFlags } = require('./flags.js');

function die(msg) {
  process.stderr.write('Error: ' + msg + '\n');
  process.exit(1);
}

function resolvePath(p) {
  return path.resolve(process.cwd(), p);
}

function cmdAnim(args) {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(`anim <subcommand> <file> [args]

Subcommands:
  query <anim> [--selector tree]
  batch <anim> <ops.json> [--project-root <path>] [--dry-run]

query 使用 AnimationClip 专用解析器，输出轨道、关键帧和只读 events。batch 是保留的 legacy prefab-op 包装，
不支持编辑 AnimationClip 曲线；新建数值曲线请用 animation_create。
`);
    return;
  }

  if (sub === 'query') {
    const { flags, positional } = parseFlags(rest);
    for (const name of Object.keys(flags)) if (name !== 'selector') die('anim query: unknown flag --' + name);
    const animArg = positional[0];
    if (!animArg) die('anim query: 必须提供 <anim>');
    const animPath = resolvePath(animArg);
    if (!fs.existsSync(animPath)) die(`anim query: 文件不存在: ${animPath}`);

    const selectorType = flags['selector'] || 'tree';
    if (selectorType !== 'tree') {
      die(`anim query: AnimationClip 只支持 --selector tree，收到 "${selectorType}"`);
    }

    let result;
    try {
      result = queryAnimationClip(animPath);
    } catch (e) {
      die('anim query 失败: ' + e.message);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (sub === 'batch') {
    const { flags, positional } = parseFlags(rest);
    for (const name of Object.keys(flags)) if (!['operation-id', 'project-root', 'dry-run'].includes(name)) die('anim batch: unknown flag --' + name);
    const [animArg, opsArg] = positional;
    if (!animArg) die('anim batch: 必须提供 <anim>');
    if (!opsArg) die('anim batch: 必须提供 <ops.json>');
    const animPath = resolvePath(animArg);
    const opsPath = resolvePath(opsArg);
    if (!fs.existsSync(animPath)) die(`anim batch: 文件不存在: ${animPath}`);
    if (!fs.existsSync(opsPath)) die(`anim batch: ops 文件不存在: ${opsPath}`);

    const opsRaw = fs.readFileSync(opsPath, 'utf8');
    let ops;
    try {
      ops = JSON.parse(opsRaw);
    } catch (e) {
      die('anim batch: ops.json 解析失败: ' + e.message);
    }
    if (!Array.isArray(ops)) die('anim batch: ops.json 必须是数组');

    const opsHash = require('../runtime/identity').hash(opsRaw);
    const editOptions = { operationId: flags['operation-id'], inputHashes: { ops: opsHash }, inputFiles: [{ file: opsPath, hash: opsHash }] };
    if (flags['project-root']) editOptions.projectRoot = resolvePath(flags['project-root']);
    if (flags['dry-run'] === true) editOptions.dryRun = true;

    let result;
    try {
      result = editPrefab(animPath, ops, editOptions);
    } catch (e) {
      throw e;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  die(`anim: 未知子命令 "${sub}"，可用: query / batch`);
}

module.exports = { cmdAnim };
