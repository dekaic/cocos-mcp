import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { artifactBaseName, buildRelease, parseGitlink } from './build-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
}

function cloneCleanProduct(tempRoot) {
    const productRoot = path.join(tempRoot, 'product');
    run('git', ['clone', '--quiet', ROOT, productRoot]);
    const sdkRoot = path.join(productRoot, 'mcp-sdk');
    fs.rmSync(sdkRoot, { recursive: true, force: true });
    run('git', ['clone', '--quiet', path.join(ROOT, 'mcp-sdk'), sdkRoot]);
    const sdkCommit = parseGitlink(run('git', ['-C', productRoot, 'ls-tree', 'HEAD', 'mcp-sdk']));
    run('git', ['-C', sdkRoot, 'checkout', '--quiet', sdkCommit]);
    assert.equal(run('git', ['-C', productRoot, 'status', '--porcelain=v1', '--untracked-files=all']), '');
    return productRoot;
}

test('release helpers reject ambiguous identities', () => {
    const commit = 'abcdef0123456789abcdef0123456789abcdef01';
    assert.equal(
        parseGitlink('160000 commit 6c2775abf25bec5f18cdbde1ee4a416f6ec9db91\tmcp-sdk'),
        '6c2775abf25bec5f18cdbde1ee4a416f6ec9db91'
    );
    assert.equal(artifactBaseName('1.2.3', commit, true), 'cocos-mcp-v1.2.3');
    assert.equal(artifactBaseName('1.2.3-rc.1', commit, true), 'cocos-mcp-v1.2.3-rc.1');
    assert.equal(artifactBaseName('1.2.3', commit, false), 'cocos-mcp-v1.2.3-candidate.abcdef0');
    assert.throws(() => artifactBaseName('next', commit, true));
    assert.throws(() => artifactBaseName('01.2.3', commit, true));
    assert.throws(() => artifactBaseName('1.2.3-01', commit, true));
    assert.throws(() => artifactBaseName('1.2.3+local', commit, true));
    assert.throws(() => artifactBaseName('1.2.3', 'abcdef0', true));
});

test('buildRelease embeds the pinned SDK and is reproducible', async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-release-test-'));
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

    const result = buildRelease({ root: ROOT, outputDir: path.join(tempRoot, 'first') });
    assert.ok(fs.existsSync(result.artifactPath));
    assert.ok(fs.existsSync(result.checksumPath));
    assert.ok(fs.existsSync(result.manifestPath));
    assert.equal(result.manifest.sdk.matchesPinned, true);
    assert.match(result.manifest.product.runtimeBuildId, /^[0-9a-f]{64}$/);

    const checksum = fs.readFileSync(result.checksumPath, 'utf8').trim();
    assert.ok(checksum.startsWith(result.manifest.artifact.sha256 + '  '));

    await new Promise((resolve) => setTimeout(resolve, 2100));
    const repeated = buildRelease({ root: ROOT, outputDir: path.join(tempRoot, 'second') });
    assert.equal(repeated.manifest.artifact.sha256, result.manifest.artifact.sha256);
});

test('buildRelease blocks a clean HEAD when its version tag points elsewhere', (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-tag-conflict-test-'));
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

    const productRoot = cloneCleanProduct(tempRoot);
    const version = JSON.parse(run('git', ['-C', productRoot, 'show', 'HEAD:package.json'])).version;
    run('git', ['-C', productRoot, 'tag', '--force', 'v' + version, 'HEAD^']);
    assert.notEqual(
        run('git', ['-C', productRoot, 'rev-parse', 'HEAD']),
        run('git', ['-C', productRoot, 'rev-parse', 'v' + version + '^{}'])
    );

    const result = buildRelease({ root: productRoot, outputDir: path.join(tempRoot, 'output') });
    assert.equal(result.manifest.product.worktreeClean, true);
    assert.equal(result.manifest.sdk.worktreeClean, true);
    assert.equal(result.manifest.sdk.matchesPinned, true);
    assert.equal(result.manifest.releaseEligible, false);
    assert.match(path.basename(result.artifactPath), /-candidate\.[0-9a-f]{7}\.zip$/);
});
