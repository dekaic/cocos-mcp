#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(
            command + ' ' + args.join(' ') + ' failed' +
            (options.cwd ? ' in ' + options.cwd : '') + ': ' +
            (result.stderr || result.stdout || '').trim()
        );
    }
    return result.stdout.trim();
}

function git(repo, args) {
    return run('git', ['-C', repo, ...args]);
}

function resolveVersionTagCommit(repo, version) {
    const result = spawnSync('git', [
        '-C', repo,
        'rev-parse', '--verify', '--quiet', 'refs/tags/v' + version + '^{commit}',
    ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    if (result.status === 1) return '';
    if (result.status !== 0) {
        throw new Error('failed to resolve version tag: ' + (result.stderr || result.stdout || '').trim());
    }
    return result.stdout.trim();
}

export function parseGitlink(output) {
    const match = String(output).match(/^160000\s+commit\s+([0-9a-f]{40})\s+mcp-sdk$/);
    assert.ok(match, 'HEAD does not contain a valid mcp-sdk gitlink: ' + output);
    return match[1];
}

export function artifactBaseName(version, commit, releaseEligible) {
    assert.match(version, PRODUCT_VERSION_RE, 'package version is not an allowed SemVer');
    assert.match(commit, /^[0-9a-f]{40}$/, 'product commit must be a full lowercase Git object id');
    return releaseEligible
        ? 'cocos-mcp-v' + version
        : 'cocos-mcp-v' + version + '-candidate.' + commit.slice(0, 7);
}

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readPackageAtCommit(root, commit) {
    const raw = git(root, ['show', commit + ':package.json']);
    const value = JSON.parse(raw);
    assert.equal(value.name, 'cocos-mcp', 'HEAD package.json is not cocos-mcp');
    return value;
}

function assertArchiveContract(artifactPath, version) {
    const entries = run('unzip', ['-Z1', artifactPath]).split('\n').filter(Boolean);
    const required = [
        'cocos-mcp/package.json',
        'cocos-mcp/main.js',
        'cocos-mcp/router/bin.js',
        'cocos-mcp/cli/bin/cocos-mcp-cli.js',
        'cocos-mcp/mcp-sdk/index.js',
        'cocos-mcp/LICENSE',
        'cocos-mcp/NOTICE',
    ];
    required.forEach((entry) => assert.ok(entries.includes(entry), 'release ZIP is missing ' + entry));
    entries.forEach((entry) => {
        assert.ok(entry === 'cocos-mcp/' || entry.startsWith('cocos-mcp/'), 'unexpected ZIP root: ' + entry);
        assert.ok(!/(^|\/)\.git(?:\/|$)/.test(entry), 'release ZIP contains Git metadata: ' + entry);
    });

    const packaged = JSON.parse(run('unzip', ['-p', artifactPath, 'cocos-mcp/package.json']));
    assert.equal(packaged.version, version, 'ZIP package version differs from HEAD package.json');
    return entries;
}

export function buildRelease(options = {}) {
    const root = path.resolve(options.root || DEFAULT_ROOT);
    const outputDir = path.resolve(options.outputDir || path.join(root, 'dist'));
    const sdkDir = path.join(root, 'mcp-sdk');
    const head = git(root, ['rev-parse', 'HEAD']);
    const sdkPinnedCommit = parseGitlink(git(root, ['ls-tree', head, 'mcp-sdk']));
    const sdkCheckoutCommit = git(sdkDir, ['rev-parse', 'HEAD']);
    const productWorktreeClean = git(root, ['status', '--porcelain=v1', '--untracked-files=all']) === '';
    const sdkWorktreeClean = git(sdkDir, ['status', '--porcelain=v1', '--untracked-files=all']) === '';
    const sdkMatchesPinned = sdkCheckoutCommit === sdkPinnedCommit;
    const packageJson = readPackageAtCommit(root, head);
    assert.match(packageJson.version, PRODUCT_VERSION_RE, 'package version is not an allowed SemVer');
    const versionTagCommit = resolveVersionTagCommit(root, packageJson.version);
    const versionTagConflict = versionTagCommit !== '' && versionTagCommit !== head;
    const releaseEligible = productWorktreeClean && sdkWorktreeClean && sdkMatchesPinned && !versionTagConflict;
    const baseName = artifactBaseName(packageJson.version, head, releaseEligible);
    const productCommitTime = Number(git(root, ['show', '-s', '--format=%ct', head]));
    const sdkCommitTime = Number(git(sdkDir, ['show', '-s', '--format=%ct', sdkPinnedCommit]));
    assert.ok(Number.isInteger(productCommitTime), 'product commit time is invalid');
    assert.ok(Number.isInteger(sdkCommitTime), 'SDK commit time is invalid');

    fs.mkdirSync(outputDir, { recursive: true });
    const artifactPath = path.join(outputDir, baseName + '.zip');
    const checksumPath = path.join(outputDir, baseName + '.sha256');
    const manifestPath = path.join(outputDir, baseName + '.manifest.json');
    [artifactPath, checksumPath, manifestPath].forEach((filePath) => {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-release-build-'));
    const stagingRoot = path.join(tempRoot, 'cocos-mcp');
    try {
        fs.mkdirSync(stagingRoot, { recursive: true });
        const productTar = path.join(tempRoot, 'product.tar');
        const sdkTar = path.join(tempRoot, 'sdk.tar');
        git(root, ['archive', '--format=tar', '--output=' + productTar, head]);
        run('tar', ['-xf', productTar, '-C', stagingRoot]);

        fs.rmSync(path.join(stagingRoot, 'mcp-sdk'), { recursive: true, force: true });
        fs.mkdirSync(path.join(stagingRoot, 'mcp-sdk'), { recursive: true });
        git(sdkDir, ['archive', '--format=tar', '--output=' + sdkTar, sdkPinnedCommit]);
        run('tar', ['-xf', sdkTar, '-C', path.join(stagingRoot, 'mcp-sdk')]);

        // These two directories are created outside git archive, so pin their
        // mtimes to commit data instead of leaking the current build time.
        fs.utimesSync(stagingRoot, productCommitTime, productCommitTime);
        fs.utimesSync(path.join(stagingRoot, 'mcp-sdk'), sdkCommitTime, sdkCommitTime);

        const runtimeBuildId = run(process.execPath, [
            '-e',
            "const r=require('./server/runtime-identity.js');process.stdout.write(r.hashRuntimeFiles(process.cwd()))",
        ], { cwd: stagingRoot });

        run('zip', ['-X', '-q', '-r', artifactPath, 'cocos-mcp'], { cwd: tempRoot });
        const entries = assertArchiveContract(artifactPath, packageJson.version);
        const artifactSha256 = sha256(artifactPath);
        fs.writeFileSync(checksumPath, artifactSha256 + '  ' + path.basename(artifactPath) + '\n');

        const manifest = {
            manifestVersion: 1,
            generatedAt: new Date().toISOString(),
            releaseEligible,
            product: {
                name: packageJson.name,
                version: packageJson.version,
                commit: head,
                worktreeClean: productWorktreeClean,
                runtimeBuildId,
            },
            sdk: {
                pinnedCommit: sdkPinnedCommit,
                checkoutCommit: sdkCheckoutCommit,
                worktreeClean: sdkWorktreeClean,
                matchesPinned: sdkMatchesPinned,
            },
            artifact: {
                file: path.basename(artifactPath),
                format: 'zip',
                rootDirectory: 'cocos-mcp',
                sha256: artifactSha256,
                entryCount: entries.length,
            },
            buildEnvironment: {
                node: process.version,
                platform: process.platform,
                arch: process.arch,
            },
        };
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
        return { artifactPath, checksumPath, manifestPath, manifest };
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function main() {
    const result = buildRelease();
    process.stdout.write(JSON.stringify({
        artifact: result.artifactPath,
        checksum: result.checksumPath,
        manifest: result.manifestPath,
        releaseEligible: result.manifest.releaseEligible,
    }, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        process.stderr.write('[build-release] FAILED: ' + (error.stack || error.message) + '\n');
        process.exitCode = 1;
    }
}
