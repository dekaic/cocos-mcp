// ============================================================
// cli/build-cmd.js — Cocos CLI 命令行打包（headless，不依赖编辑器/MCP）
//
// 封装 Cocos Creator 的命令行构建：
//   CocosCreator --project <path> --build "configPath=<json>"
//   CocosCreator --project <path> --build "platform=<plat>;debug=<bool>"
//
// 退出码：Cocos 退出非 0 常见于 Builder 已完成后的 Electron 收尾阶段。
//   因此不能只看进程码，也不能接受上一次遗留的旧产物：必须验证本次启动后生成的关键文件。
//   --strict 还会在 Cocos 返回 0 时强制要求可定位、可解析且时间戳新鲜的产物。
//
// 用法：
//   cocos-mcp-cli build --project <path> --version 3.8.8 --config <buildConfig.json>
//   cocos-mcp-cli build --project <path> --cocos <CocosCreator可执行> --platform web-mobile
//   cocos-mcp-cli build ... --dry-run     # 只打印命令不真跑
//   cocos-mcp-cli build ... --strict      # 严格验证本次构建产物
// ============================================================

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

function resolveOutputDir(a) {
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
    return outDir || null;
}

// 验证产物来自本次构建，而非 build/ 里遗留的旧文件。
function inspectArtifact(a, startedAt) {
    const outDir = resolveOutputDir(a);
    if (!outDir) return { valid: false, reason: 'cannot locate output directory' };
    if (!fs.existsSync(outDir)) return { valid: false, reason: 'artifact directory is missing', outDir };

    const markerNames = ['index.html', 'game.json', 'application.js', path.join('src', 'settings.json')];
    const markers = markerNames
        .map((name) => path.join(outDir, name))
        .filter((file) => fs.existsSync(file));
    if (markers.length === 0) return { valid: false, reason: 'required artifact markers are missing', outDir };

    const newestMtime = Math.max.apply(null, markers.map((file) => fs.statSync(file).mtimeMs));
    // 常见文件系统时间戳精度为 1 秒，留 2 秒容差。
    if (newestMtime < startedAt - 2000) {
        return { valid: false, reason: 'stale artifact from an earlier build', outDir, newestMtime };
    }

    const settingsPath = path.join(outDir, 'src', 'settings.json');
    if (fs.existsSync(settingsPath)) {
        try { JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
        catch (e) { return { valid: false, reason: 'generated settings.json is invalid JSON', outDir }; }
    }
    return { valid: true, reason: 'fresh verified artifact', outDir, markers };
}

function cmdBuild(rest) {
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
            '  --strict               严格验证本次产物；Creator 返回 0 但产物缺失/陈旧也判失败\n\n' +
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

    process.stdout.write('Cocos CLI build 启动（headless，可能耗时几分钟）:\n  --project ' + a.project + '\n  --build "' + buildArg + '"\n\n');
    const startedAt = Date.now();
    const child = spawn(cocos, argv, { stdio: 'inherit' });
    child.on('error', function (e) { die('启动 Cocos 失败: ' + e.message); });
    child.on('exit', function (code) {
        const artifact = inspectArtifact(a, startedAt);
        if (code === 0) {
            if (a.strict && !artifact.valid) {
                process.stdout.write('\nCocos 退出码: 0，但严格产物验证失败：' + artifact.reason + ' → 构建失败。\n');
                process.exit(1);
                return;
            }
            process.stdout.write('\nCocos 退出码: 0 — 构建成功' +
                (artifact.valid ? '（' + artifact.reason + '）' : '（产物未验证：' + artifact.reason + '）') + '\n');
            process.exit(0);
            return;
        }
        if (artifact.valid) {
            process.stdout.write('\nCocos 退出码: ' + code + '（非 0），但检测到 ' + artifact.reason +
                ' → 判定 Builder 主构建成功。\n');
            process.exit(0);
            return;
        }
        process.stdout.write('\nCocos 退出码: ' + (code == null ? '(被信号终止)' : code) +
            '，产物验证失败：' + artifact.reason + ' → 构建失败。\n');
        process.exit(code == null ? 1 : code);
    });
}

module.exports = { cmdBuild, resolveOutputDir, inspectArtifact };
