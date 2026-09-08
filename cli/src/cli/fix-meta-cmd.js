// ============================================================
// cli/fix-meta-cmd.js — fix-meta 子命令
//
// 用法：
//   cocos-mcp-cli fix-meta [--project <dir>] [--dry-run | --apply --operation-id <id>]
//
// 清理 Cocos 重启造成的图片 meta 噪音（保守，只还原能确认是破坏的）：
//   1) 纯 key 顺序/格式变化（值没变）→ 还原成 git 原文
//   2) 九宫格 border 被重置成 0 → 用 git 的值精准还原
//   3) trimType 从 none 被改成自动裁剪 → 还原该 frame 到 git（恢复不裁剪）
//   默认只预演；正式应用须显式 --apply、操作 ID 和已关闭的 Creator。
//   --project 指定 Cocos 项目根目录（默认当前目录）。
// ============================================================

'use strict';

const { fixMeta } = require('../editor/fix-meta.js');

function die(msg) { process.stderr.write('Error: ' + msg + '\n'); process.exit(1); }

function cmdFixMeta(argv) {
  let project = process.cwd();
  let dryRun = true;
  let operationId;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--apply') {
      dryRun = false;
    } else if (a === '--operation-id') {
      operationId = argv[++i];
    } else if (a === '--project' || a === '-p') {
      project = argv[++i];
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'cocos-mcp-cli fix-meta — 清理 Cocos 重启造成的图片 meta 噪音\n\n' +
        '  --project, -p <dir>   Cocos 项目根目录（含 assets/ 和 package.json，默认当前目录）\n' +
        '  --dry-run             默认只预演将还原哪些，不写资源\n' +
        '  --apply               显式应用修复；目标 Creator 必须已关闭\n' +
        '  --operation-id <id>    正式应用必填；未知结果先查询原操作，不换 ID 重放\n\n' +
        '处理三类（都靠 git 对比，正确处理中文路径，保守只还原能确认的）：\n' +
        '  1) 纯 key 顺序/格式变化（值没变）→ 还原成 git 原文\n' +
        '  2) 九宫格 border 被重置成 0 → 用 git 的值精准还原\n' +
        '  3) trimType 从 none 被改成自动裁剪 → 还原该 frame 到 git（恢复不裁剪）\n');
      return;
    } else {
      die('未知参数 "' + a + '"');
    }
  }

  let r;
  try {
    r = fixMeta(project, { dryRun: dryRun, operationId });
  } catch (e) {
    die(e.message);
  }

  process.stdout.write(
    (dryRun ? '[dry-run] ' : '') +
    '扫描 ' + r.scanned + ' 个改动 meta：顺序还原 ' + r.reorderFiles +
    ' 个，值修复 ' + r.fixedFiles + ' 个 meta（border ' + r.borderFrames + ' frame / trim ' + r.trimFrames + ' frame）\n');

  if (r.details.length) {
    process.stdout.write(r.details.slice(0, 50).join('\n') + '\n');
    if (r.details.length > 50) process.stdout.write('...（共 ' + r.details.length + ' 处，只列前 50）\n');
  }
}

module.exports = { cmdFixMeta };
