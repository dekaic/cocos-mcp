'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '../bin/cocos-mcp-cli.js');

function makeProject(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cocos-build-${tag}-`));
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"build-test"}\n');
  const config = path.join(root, 'config', 'release.json');
  fs.writeFileSync(config, JSON.stringify({
    platform: 'web-mobile', buildPath: 'project://build', outputName: 'web-mobile-release', debug: false,
  }));
  return { root, config };
}

function makeFakeCreator(root, writesArtifact) {
  const file = path.join(root, writesArtifact ? 'fake-success.js' : 'fake-fail.js');
  const body = writesArtifact
    ? `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const args=process.argv.slice(2); const project=args[args.indexOf('--project')+1];
const out=path.join(project,'build','web-mobile-release'); fs.mkdirSync(path.join(out,'src'),{recursive:true});
fs.writeFileSync(path.join(out,'index.html'),'<html></html>');
fs.writeFileSync(path.join(out,'application.js'),'ok');
fs.writeFileSync(path.join(out,'src','settings.json'),JSON.stringify({CocosEngine:'3.8.8',engine:{debug:false}}));
process.exit(36);
`
    : '#!/usr/bin/env node\nprocess.exit(36);\n';
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

test('build --strict accepts a fresh verified artifact even when Creator exits 36', () => {
  const project = makeProject('fresh');
  try {
    const fake = makeFakeCreator(project.root, true);
    const result = spawnSync(process.execPath, [CLI, 'build', '--project', project.root, '--cocos', fake, '--config', project.config, '--strict'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /fresh verified artifact/i);
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true });
  }
});

test('build rejects a stale artifact left by an earlier build', () => {
  const project = makeProject('stale');
  try {
    const out = path.join(project.root, 'build', 'web-mobile-release');
    fs.mkdirSync(path.join(out, 'src'), { recursive: true });
    for (const rel of ['index.html', 'application.js', 'src/settings.json']) {
      const file = path.join(out, rel);
      fs.writeFileSync(file, rel.endsWith('.json') ? '{}' : 'old');
      fs.utimesSync(file, new Date(1_000), new Date(1_000));
    }
    const fake = makeFakeCreator(project.root, false);
    const result = spawnSync(process.execPath, [CLI, 'build', '--project', project.root, '--cocos', fake, '--config', project.config], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /stale artifact/i);
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true });
  }
});
