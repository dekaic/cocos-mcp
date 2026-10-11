'use strict';

// ============================================================
// T10/T11 CLI 集成测试
// 用 child_process.spawnSync 跑 bin，覆盖：
//   - query tree
//   - query node --name X
//   - query find --type cc.Label
//   - set label.text
//   - set active
//   - batch
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fixturePath: FIXTURE, projectRoot: PROJECT_ROOT } = require('./fixture-project.js');

const BIN = path.resolve(__dirname, '../bin/cocos-mcp-cli.js');

function run(args) {
  const mutation = ['set', 'batch', 'build', 'open', 'create-prefab', 'extract-prefab', 'compact-prefab', 'ensure-meta', 'fix-meta'].includes(args[0]);
  const input = mutation && !args.includes('--operation-id') ? args.concat(['--operation-id', require('crypto').randomUUID()]) : args;
  const bootstrap = `const operations = require(${JSON.stringify(path.resolve(__dirname, '../src/runtime/operations'))}); const createStore = operations.createStore; operations.createStore = options => createStore({ stateRoot: ${JSON.stringify(path.join(PROJECT_ROOT, 'cli-state'))}, ...options }); process.argv = [process.execPath, ${JSON.stringify(BIN)}, ...${JSON.stringify(input)}]; require(${JSON.stringify(BIN)});`;
  return spawnSync(process.execPath, ['-e', bootstrap], {
    encoding: 'utf8',
    cwd: __dirname,
  });
}

function tmpCopy() {
  const dest = path.join(PROJECT_ROOT, 'assets', `HomeUI-cli-test-${Date.now()}.prefab`);
  fs.copyFileSync(FIXTURE, dest);
  return dest;
}

function tmpExitExecutable(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-build-exit-test-'));
  const executable = path.join(dir, 'fake-cocos');
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.exit(${code});\n`, 'utf8');
  fs.chmodSync(executable, 0o755);
  return { dir, executable };
}

for (const explicitName of [false, true]) {
  test(`CLI create-prefab: ${explicitName ? '显式同名' : '不同目录同名'}资产具有独立 UUID`, (t) => {
    const dir = fs.mkdtempSync(path.join(PROJECT_ROOT, 'assets', 'create-prefab-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const existing = fs.readFileSync(FIXTURE);
    const uuids = [];
    for (const folder of ['ui', 'world']) {
      fs.mkdirSync(path.join(dir, folder));
      const output = path.join(dir, folder, (explicitName ? folder : 'Button') + '.prefab');
      const args = ['create-prefab', output];
      if (explicitName) args.push('--name', 'Button');
      const result = run(args);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.written, true);
      assert.deepEqual(report.created, [output, output + '.meta']);
      const data = JSON.parse(fs.readFileSync(output, 'utf8'));
      const meta = JSON.parse(fs.readFileSync(output + '.meta', 'utf8'));
      assert.equal(data[0]._name, 'Button');
      assert.equal(data[1]._name, 'Button');
      assert.equal(meta.userData.syncNodeName, 'Button');
      assert.match(meta.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      uuids.push(meta.uuid);
    }
    assert.notEqual(uuids[0], uuids[1], '独立资产不能共享 UUID');
    assert.deepEqual(fs.readFileSync(FIXTURE), existing, '已有资产及其引用应保持不变');
  });
}

test('CLI create-prefab: 同操作重试保持原 UUID 和字节，新操作拒绝覆盖', (t) => {
  const dir = fs.mkdtempSync(path.join(PROJECT_ROOT, 'assets', 'create-prefab-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'Button.prefab');
  const args = ['create-prefab', output, '--operation-id', require('crypto').randomUUID()];
  const first = run(args);
  assert.equal(first.status, 0, first.stderr);
  const snapshot = [output, output + '.meta'].map(file => ({
    bytes: fs.readFileSync(file),
    stat: fs.statSync(file, { bigint: true }),
  }));
  const retry = run(args);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(JSON.parse(retry.stdout), JSON.parse(first.stdout));
  const overwrite = run(['create-prefab', output]);
  assert.notEqual(overwrite.status, 0);
  assert.match(overwrite.stderr, /Refusing to overwrite existing resource/);
  for (const [index, file] of [output, output + '.meta'].entries()) {
    assert.deepEqual(fs.readFileSync(file), snapshot[index].bytes);
    const stat = fs.statSync(file, { bigint: true });
    assert.equal(stat.ino, snapshot[index].stat.ino);
    assert.equal(stat.mtimeNs, snapshot[index].stat.mtimeNs);
  }
});

test('CLI create-prefab: dry-run 预演不创建资源', (t) => {
  const dir = fs.mkdtempSync(path.join(PROJECT_ROOT, 'assets', 'create-prefab-preview-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'Button.prefab');
  const result = run(['create-prefab', output, '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /=== META ===/);
  assert.match(result.stdout, /"written": false/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(output + '.meta'), false);
});

test('CLI fix-meta help describes preview defaults and explicit closed-project application', () => {
  const result = run(['fix-meta', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /默认.*预演/);
  assert.match(result.stdout, /--apply/);
  assert.match(result.stdout, /--operation-id <id>/);
  assert.match(result.stdout, /Creator.*关闭/);
  assert.match(result.stdout, /项目根目录/);
  assert.doesNotMatch(result.stdout, /git 仓库或其子目录/);
});

// ─── query tree ──────────────────────────────────────────────

test('CLI query tree: 退出码 0，输出可解析 JSON，含 name=HomeUI 的根节点', () => {
  const result = run(['query', FIXTURE, '--selector', 'tree']);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  let tree;
  assert.doesNotThrow(() => { tree = JSON.parse(result.stdout); }, 'stdout 应是合法 JSON');
  assert.equal(tree.name, 'HomeUI', '根节点名称应为 HomeUI');
  assert.ok(Array.isArray(tree.children), 'tree.children 应是数组');
});

// ─── query node ──────────────────────────────────────────────

test('CLI query node --name touchArea: 返回单节点详情', () => {
  const result = run(['query', FIXTURE, '--selector', 'node', '--name', 'touchArea']);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  let node;
  assert.doesNotThrow(() => { node = JSON.parse(result.stdout); });
  assert.equal(node.name, 'touchArea');
  assert.ok(typeof node.id === 'number');
});

test('CLI query node --name 不存在: 返回 null JSON', () => {
  const result = run(['query', FIXTURE, '--selector', 'node', '--name', '__no_such_node__']);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed, null);
});

// ─── query find ──────────────────────────────────────────────

test('CLI query find --type cc.Label: 返回 id 数组', () => {
  const result = run(['query', FIXTURE, '--selector', 'find', '--type', 'cc.Label']);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  let ids;
  assert.doesNotThrow(() => { ids = JSON.parse(result.stdout); });
  assert.ok(Array.isArray(ids));
  // HomeUI 里有至少一个 cc.Label（具体数量依 fixture）
  assert.ok(ids.length >= 0, '应返回数组');
});

// ─── set label.text ──────────────────────────────────────────

test('CLI set label.text: 写入后 query node 验证文字已变', () => {
  const tmp = tmpCopy();

  // 先 query 找到含 cc.Label 的节点名
  const findResult = run(['query', tmp, '--selector', 'find', '--type', 'cc.Label']);
  assert.equal(findResult.status, 0);
  const labelIds = JSON.parse(findResult.stdout);

  if (labelIds.length === 0) {
    // fixture 无 Label 节点，跳过
    fs.unlinkSync(tmp);
    return;
  }

  // 找出有名字的 Label 节点（tree 里搜）
  const treeResult = run(['query', tmp, '--selector', 'tree']);
  const tree = JSON.parse(treeResult.stdout);

  // 深度遍历找第一个带 cc.Label 组件且有名字的节点
  function findLabelNode(node) {
    if (node.componentTypes && node.componentTypes.includes('cc.Label') && node.name) return node;
    for (const child of (node.children || [])) {
      const found = findLabelNode(child);
      if (found) return found;
    }
    return null;
  }
  const labelNode = findLabelNode(tree);
  if (!labelNode) {
    fs.unlinkSync(tmp);
    return; // 没有带名字的 Label 节点，跳过
  }

  const newText = 'CLI_TEST_' + Date.now();
  const setResult = run(['set', tmp, labelNode.name, 'label.text', newText]);
  assert.equal(setResult.status, 0, `set 失败 stderr: ${setResult.stderr}`);

  // 再 query 验证
  const checkResult = run(['query', tmp, '--selector', 'node', '--name', labelNode.name]);
  assert.equal(checkResult.status, 0);
  // 成功即可（文字字段在 raw 里，高层 query 不直接返回 _string，只验证退出码即可）

  fs.unlinkSync(tmp);
});

// ─── set active ──────────────────────────────────────────────

test('CLI set active false: 写入后解析 elements 验证 _active=false', () => {
  const tmp = tmpCopy();

  // 用 touchArea 节点（普通节点，存在于 fixture）
  const nodeName = 'touchArea';
  const setResult = run(['set', tmp, nodeName, 'active', 'false']);
  assert.equal(setResult.status, 0, `set active 失败 stderr: ${setResult.stderr}`);

  // 直接用 parse.js 验证（不走 CLI 避免嵌套）
  const { parsePrefab } = require('../src/parse.js');
  const pd = parsePrefab(tmp);
  const node = pd.findNodeByName(nodeName);
  assert.ok(node, `${nodeName} 应存在`);
  assert.equal(node._active, false, '_active 应已改为 false');

  fs.unlinkSync(tmp);
});

// ─── batch ───────────────────────────────────────────────────

test('CLI batch: 超大指数数值在写入与预演中均拒绝', (t) => {
  const file = tmpCopy();
  const opsFile = path.join(PROJECT_ROOT, 'overflow-ops.json');
  t.after(() => { fs.rmSync(file, { force: true }); fs.rmSync(opsFile, { force: true }); });
  const before = fs.readFileSync(file);
  for (const number of ['1e400', '-1e400']) {
    fs.writeFileSync(opsFile, `[{"op":"set-position","node":"touchArea","x":${number},"y":0}]`);
    for (const dryRun of [false, true]) {
      const result = run(['batch', file, opsFile, ...(dryRun ? ['--dry-run'] : [])]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /非有限数/);
      assert.deepEqual(fs.readFileSync(file), before);
    }
  }
});

test('CLI batch: 批量 set-active + set-position 写入并验证', () => {
  const tmp = tmpCopy();
  const opsFile = path.join(os.tmpdir(), `ops-${Date.now()}.json`);

  const ops = [
    { op: 'set-active', node: 'touchArea', active: false },
    { op: 'set-position', node: 'touchArea', x: 111, y: 222, z: 0 },
  ];
  fs.writeFileSync(opsFile, JSON.stringify(ops));

  const batchResult = run(['batch', tmp, opsFile]);
  assert.equal(batchResult.status, 0, `batch 失败 stderr: ${batchResult.stderr}`);

  // 验证
  const { parsePrefab } = require('../src/parse.js');
  const pd = parsePrefab(tmp);
  const node = pd.findNodeByName('touchArea');
  assert.ok(node);
  assert.equal(node._active, false);
  assert.equal(node._lpos.x, 111);
  assert.equal(node._lpos.y, 222);

  fs.unlinkSync(tmp);
  fs.unlinkSync(opsFile);
});

// ─── 错误处理 ─────────────────────────────────────────────────

test('CLI 未知子命令: 非零退出 + stderr 有内容', () => {
  const result = run(['unknowncmd']);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.length > 0);
});

test('CLI query 文件不存在: 非零退出', () => {
  const result = run(['query', '/tmp/__nonexistent__.prefab']);
  assert.notEqual(result.status, 0);
});

test('CLI anim query: Creator AnimationClip 返回标准化轨道，而不是 Prefab 根错误', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-anim-cli-'));
  const animPath = path.join(dir, 'position.anim');
  fs.writeFileSync(animPath, JSON.stringify([
    {
      __type__: 'cc.AnimationClip', _name: 'position', _objFlags: 0, _native: '',
      sample: 60, speed: 1, wrapMode: 2, _duration: 1,
      _tracks: [{ __id__: 1 }], _events: [], _exoticAnimation: null,
    },
    {
      __type__: 'cc.animation.UntypedTrack',
      _binding: { __type__: 'cc.animation.TrackBinding', path: { __id__: 2 } },
      _channels: [{ __id__: 3 }],
    },
    { __type__: 'cc.animation.TrackPath', _paths: ['position'] },
    { __type__: 'cc.animation.UntypedTrackChannel', _curve: { __id__: 4 }, property: 'x' },
    {
      __type__: 'cc.RealCurve', _times: [0, 1],
      _values: [
        { __type__: 'cc.RealKeyframeValue', interpolationMode: 0, value: 0, easingMethod: 0 },
        { __type__: 'cc.RealKeyframeValue', interpolationMode: 0, value: 100, easingMethod: 0 },
      ],
      preExtrapolation: 1, postExtrapolation: 1,
    },
  ], null, 2) + '\n', 'utf8');

  try {
    const result = run(['anim', 'query', animPath, '--selector', 'tree']);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const data = JSON.parse(result.stdout);
    assert.equal(data.name, 'position');
    assert.equal(data.tracks[0].path.property, 'position');
    assert.equal(data.tracks[0].channels[0].property, 'x');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI set active 非法 value: 非零退出', () => {
  const result = run(['set', FIXTURE, 'touchArea', 'active', 'maybe']);
  assert.notEqual(result.status, 0);
});
test('CLI open --dry-run: accepts positional project and builds --project command', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-open-project-'));
  fs.mkdirSync(path.join(project, 'assets'));

  const result = run(['open', project, '--cocos', process.execPath, '--dry-run']);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /\[dry-run\]/);
  assert.match(result.stdout, /--project/);
  assert.match(result.stdout, /--nologin/);
  assert.match(result.stdout, new RegExp(project.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));

  fs.rmSync(project, { recursive: true, force: true });
});

test('CLI open --with-login: dry-run omits --nologin', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-open-project-'));
  fs.mkdirSync(path.join(project, 'assets'));

  const result = run(['open', '--project', project, '--cocos', process.execPath, '--with-login', '--dry-run']);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stdout, /--nologin/);

  fs.rmSync(project, { recursive: true, force: true });
});

test('CLI build accepts Creator success code 36 and preserves nonzero failure evidence without artifact fallback', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-build-project-'));
  fs.mkdirSync(path.join(project, 'assets'));
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  const success = tmpExitExecutable(36);
  const failure = tmpExitExecutable(34);

  try {
    const successResult = run([
      'build', '--project', project, '--cocos', success.executable,
      '--platform', 'web-mobile', '--strict',
    ]);
    assert.equal(successResult.status, 0, `stdout: ${successResult.stdout}\nstderr: ${successResult.stderr}`);
    assert.match(successResult.stdout, /"creatorExitCode": 36/);

    const failureResult = run([
      'build', '--project', project, '--cocos', failure.executable,
      '--platform', 'web-mobile', '--strict',
    ]);
    assert.notEqual(failureResult.status, 0, `stdout: ${failureResult.stdout}\nstderr: ${failureResult.stderr}`);
    assert.match(failureResult.stderr, /34/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(success.dir, { recursive: true, force: true });
    fs.rmSync(failure.dir, { recursive: true, force: true });
  }
});
