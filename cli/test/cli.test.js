'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { parsePrefab } = require('../src/parse.js');
const { createFixtureProject } = require('./helpers/fixture-project.js');

const BIN = path.resolve(__dirname, '../bin/cocos-mcp-cli.js');

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: __dirname,
  });
}

test('CLI query: tree/node/find/field 返回可解析结果', (t) => {
  const fixture = createFixtureProject(t, 'cli-query');

  const treeResult = run(['query', fixture.hostPath, '--selector', 'tree']);
  assert.equal(treeResult.status, 0, treeResult.stderr);
  assert.equal(JSON.parse(treeResult.stdout).name, fixture.names.root);

  const nodeResult = run([
    'query', fixture.hostPath,
    '--selector', 'node',
    '--name', fixture.names.plain,
  ]);
  assert.equal(nodeResult.status, 0, nodeResult.stderr);
  assert.equal(JSON.parse(nodeResult.stdout).name, fixture.names.plain);

  const findResult = run([
    'query', fixture.hostPath,
    '--selector', 'find',
    '--type', 'cc.Label',
  ]);
  assert.equal(findResult.status, 0, findResult.stderr);
  assert.equal(JSON.parse(findResult.stdout).length, 1);

  const fieldResult = run([
    'query', fixture.hostPath,
    '--selector', 'field',
    '--name', fixture.names.label,
    '--comp', 'cc.Label',
    '--field', '_string',
  ]);
  assert.equal(fieldResult.status, 0, fieldResult.stderr);
  assert.equal(JSON.parse(fieldResult.stdout), 'Start');
});

test('CLI query overrides: 能解析自包含 nested Prefab', (t) => {
  const fixture = createFixtureProject(t, 'cli-overrides');
  const result = run([
    'query', fixture.hostPath,
    '--selector', 'overrides',
    '--name', fixture.names.nested,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.nestedPrefab, fixture.nestedPath);
  assert.equal(parsed.propertyOverrides.length, 2);
});

test('CLI set: label.text 与 active 会真实写入 Prefab', (t) => {
  const fixture = createFixtureProject(t, 'cli-set');

  const labelResult = run([
    'set', fixture.hostPath, fixture.names.label, 'label.text', 'Updated',
  ]);
  assert.equal(labelResult.status, 0, labelResult.stderr);

  const activeResult = run([
    'set', fixture.hostPath, fixture.names.plain, 'active', 'false',
  ]);
  assert.equal(activeResult.status, 0, activeResult.stderr);

  const parsed = parsePrefab(fixture.hostPath);
  const labelNode = parsed.findNodeByName(fixture.names.label);
  const label = parsed.elements[labelNode._components[0].__id__];
  assert.equal(label._string, 'Updated');
  assert.equal(parsed.findNodeByName(fixture.names.plain)._active, false);
});

test('CLI batch: dry-run 不落盘，正式执行应用全部 op', (t) => {
  const fixture = createFixtureProject(t, 'cli-batch');
  const opsPath = path.join(fixture.root, 'ops.json');
  const ops = [
    { op: 'set-active', node: fixture.names.plain, active: false },
    { op: 'set-position', node: fixture.names.plain, x: 111, y: 222, z: 3 },
  ];
  fs.writeFileSync(opsPath, JSON.stringify(ops), 'utf8');
  const before = fs.readFileSync(fixture.hostPath, 'utf8');

  const dryRun = run(['batch', fixture.hostPath, opsPath, '--dry-run']);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).dryRun, true);
  assert.equal(fs.readFileSync(fixture.hostPath, 'utf8'), before);

  const applied = run(['batch', fixture.hostPath, opsPath]);
  assert.equal(applied.status, 0, applied.stderr);
  const node = parsePrefab(fixture.hostPath).findNodeByName(fixture.names.plain);
  assert.equal(node._active, false);
  assert.deepEqual(
    { x: node._lpos.x, y: node._lpos.y, z: node._lpos.z },
    { x: 111, y: 222, z: 3 }
  );
});

test('CLI 错误路径: 缺失文件、未知命令和非法布尔值均给出真实错误', (t) => {
  const fixture = createFixtureProject(t, 'cli-errors');

  const unknown = run(['unknowncmd']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /未知子命令/);

  const missing = run(['query', path.join(fixture.root, 'missing.prefab')]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /文件不存在/);

  const invalid = run([
    'set', fixture.hostPath, fixture.names.plain, 'active', 'maybe',
  ]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /value 必须是 true 或 false/);
});

test('CLI open --dry-run: positional project 生成无登录启动命令', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-open-project-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, 'assets'));

  const result = run(['open', project, '--cocos', process.execPath, '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\]/);
  assert.match(result.stdout, /--project/);
  assert.match(result.stdout, /--nologin/);
  assert.match(result.stdout, new RegExp(project.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
});

test('CLI open --with-login: dry-run 不添加 --nologin', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-open-project-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, 'assets'));

  const result = run([
    'open', '--project', project,
    '--cocos', process.execPath,
    '--with-login', '--dry-run',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /--nologin/);
});
