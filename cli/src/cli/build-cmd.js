// ============================================================
// cli/build-cmd.js — Cocos CLI 命令行打包（headless，不依赖编辑器/MCP）
//
// 封装 Cocos Creator 的命令行构建：
//   CocosCreator --project <path> --build "configPath=<json>"
//   CocosCreator --project <path> --build "platform=<plat>;debug=<bool>"
//
// 退出码：仅 Creator 0/36 归一为成功；旧产物不覆盖失败或未知后果。
// --strict 保留为兼容参数，所有模式均采用上述判定与项目执行门禁。
//
// 用法：
//   cocos-mcp-cli build --project <path> --version 3.8.8 --config <buildConfig.json>
//   cocos-mcp-cli build --project <path> --cocos <CocosCreator可执行> --platform web-mobile
//   cocos-mcp-cli build ... --dry-run     # 只打印命令不真跑
//   cocos-mcp-cli build ... --strict      # 不做产物兜底；0/36 成功，其余退出码透传
// ============================================================

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { executeLifecycle } = require('../runtime/lifecycle');
const { unwrap } = require('../runtime/transactions');
const { assertClosed } = require('../runtime/processes');
const { hash, fault } = require('../runtime/identity');

function die(msg) { process.stderr.write('Error: ' + msg + '\n'); process.exit(1); }

function parseArgs(rest) {
    const a = { project: '', cocos: '', version: '', config: '', platform: '', debug: false, dryRun: false, strict: false };
    for (let i = 0; i < rest.length; i++) {
        const k = rest[i];
        if (k === '--project' || k === '-p') a.project = rest[++i];
        else if (k === '--cocos' || k === '-c') a.cocos = rest[++i];
        else if (k === '--version' || k === '-v') a.version = rest[++i];
        else if (k === '--config') a.config = rest[++i];
        else if (k === '--platform') a.platform = rest[++i];
        else if (k === '--debug') a.debug = true;
        else if (k === '--dry-run') a.dryRun = true;
        else if (k === '--strict') a.strict = true;
        else if (k === '--operation-id') a.operationId = rest[++i];
        else die(`未知参数 "${k}"。用法见 cocos-mcp-cli build --help`);
    }
    return a;
}

// 按平台拼 Cocos Creator 标准安装路径。Win/Linux 路径规律待目标平台实测，建议优先用 --cocos 显式。
function cocosStdPath(ver) {
    if (process.platform === 'darwin') {
        return `/Applications/Cocos/Creator/${ver}/CocosCreator.app/Contents/MacOS/CocosCreator`;
    }
    if (process.platform === 'win32') {
        // TODO[win-verify]: Win 上 CocosDashboard 安装路径待实测确认（下面是常见默认，未验证）
        return `C:\\ProgramData\\cocos\\editors\\Creator\\${ver}\\CocosCreator.exe`;
    }
    return ''; // linux 等：无标准约定，要求 --cocos 显式
}

// 解析 CocosCreator 可执行：--cocos 显式优先，否则 --version 拼标准安装路径
function resolveCocos(a) {
    if (a.cocos) {
        if (!fs.existsSync(a.cocos)) die(`--cocos 路径不存在: ${a.cocos}`);
        return a.cocos;
    }
    if (a.version) {
        const p = cocosStdPath(a.version);
        if (!p || !fs.existsSync(p)) die(`版本 ${a.version} 不在标准安装路径${p ? ': ' + p : ''}\n  用 --cocos <可执行绝对路径> 显式指定`);
        return p;
    }
    die('需指定 CocosCreator 可执行：--cocos <path> 或 --version <如 3.8.8>');
}

// 只报告产物存在性，不将旧产物用作本次构建成功的证据。
function checkArtifact(a) {
    let outDir;
    if (a.platform) {
        // outputName 默认等于 platform；非默认场景请用 --config
        outDir = path.join(a.project, 'build', a.platform);
    } else if (a.config) {
        try {
            const cfg = JSON.parse(fs.readFileSync(a.config, 'utf8'));
            const bp = String(cfg.buildPath || 'project://build').replace(/^project:\/\//, a.project + path.sep);
            const on = cfg.outputName || cfg.platform || '';
            outDir = path.join(bp, on);
        } catch (e) { return null; }
    }
    if (!outDir || !fs.existsSync(outDir)) return false;
    // 关键产物标志：index.html(web) / game.json(小游戏) / application.js
    return ['index.html', 'game.json', 'application.js'].some(function (m) { return fs.existsSync(path.join(outDir, m)); });
}

async function cmdBuild(rest) {
    if (rest[0] === '--help' || rest[0] === '-h') {
        process.stdout.write(
            'cocos-mcp-cli build — Cocos 命令行打包（headless）\n\n' +
            '  --project, -p <path>   项目根目录（必填）\n' +
            '  --version, -v <ver>    Cocos 版本（拼标准安装路径，如 3.8.8）\n' +
            '  --cocos,   -c <path>   或直接给 CocosCreator 可执行绝对路径（优先于 --version）\n' +
            '  --config <json>        构建配置文件（→ --build "configPath=<json>"）\n' +
            '  --platform <plat>      或按平台构建（→ --build "platform=<plat>"），如 web-mobile / alipay-mini-game\n' +
            '  --debug                平台构建时 debug=true（默认 false）\n' +
            '  --dry-run              只打印将执行的命令，不真跑\n' +
            '  --operation-id <id>    正式构建必填；目标 Creator 须关闭，重试先查询同一操作\n' +
            '  --strict               保留参数；所有模式仅 0/36 成功，其他后果需检查\n\n' +
            '示例:\n' +
            '  cocos-mcp-cli build -p /path/to/forest -v 3.8.8 --config /path/build.json\n' +
            '  cocos-mcp-cli build -p /path/to/forest -v 3.8.8 --platform web-mobile --dry-run\n');
        return;
    }

    const a = parseArgs(rest);
    if (!a.project) die('缺 --project <项目路径>');
    if (!fs.existsSync(a.project)) die(`项目路径不存在: ${a.project}`);
    if (!a.config && !a.platform) die('需指定构建配置：--config <buildConfig.json> 或 --platform <平台>');

    const cocos = resolveCocos(a);

    let buildArg;
    if (a.config) {
        a.config = path.resolve(a.config);
        if (!fs.existsSync(a.config)) die(`--config 文件不存在: ${a.config}`);
        buildArg = `configPath=${a.config}`;
    } else {
        buildArg = `platform=${a.platform};debug=${a.debug ? 'true' : 'false'}`;
    }

    const argv = ['--project', a.project, '--build', buildArg];

    if (a.dryRun) {
        process.stdout.write('[dry-run] 将执行:\n  ' + cocos + ' --project ' + a.project + ' --build "' + buildArg + '"\n');
        return;
    }

    const configHash = a.config ? hash(fs.readFileSync(a.config)) : null;
    const record = await executeLifecycle('cli_build', { projectPath: path.resolve(a.project), operationId: a.operationId,
        execPath: cocos, buildArg, strict: a.strict, configHash,
    }, { assertTarget: () => {
        assertClosed(path.resolve(a.project));
        if (a.config && hash(fs.readFileSync(a.config)) !== configHash) throw fault('INPUT_CHANGED', 'Build config changed before execution: ' + a.config);
    } }, async entry => {
        const child = spawn(cocos, argv, { stdio: 'inherit' });
        const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        entry.child(child.pid);
        const result = await exited;
        const artifactPresent = checkArtifact(a);
        if (result.code !== 0 && result.code !== 36) {
            throw new Error('Creator exited with code ' + result.code + '; partial build side effects require inspection. Existing artifacts do not prove this build succeeded.');
        }
        return { action: 'build', creatorExitCode: result.code, artifactPresent };
    });
    process.stdout.write(JSON.stringify(unwrap(record), null, 2) + '\n');
}

module.exports = { cmdBuild };
