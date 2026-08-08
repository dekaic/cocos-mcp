'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { parsePrefab } = require('../src/parse.js');
const { writePrefab, detectIndent, detectTrailingNewline } = require('../src/write.js');
const { setOverrideProperty, listOverrides } = require('../src/overrides.js');
const {
  createFixtureProject,
  findNodeId,
  parseWithResolver,
} = require('./helpers/fixture-project.js');

test('parsePrefab: 读取自包含 Prefab 并提供根、引用和查询 API', (t) => {
  const fixture = createFixtureProject(t, 'parse');
  const parsed = parsePrefab(fixture.hostPath);

  assert.ok(parsed.raw.length > 0);
  assert.ok(parsed.elements.length > 0);
  assert.equal(parsed.getRoot()._name, fixture.names.root);
  assert.equal(parsed.resolveRef({ __id__: 0 }).__type__, 'cc.Prefab');
  assert.equal(parsed.resolveRef({ __id__: 1 }).__type__, 'cc.Node');
  assert.equal(parsed.findNodeByName(fixture.names.plain)._name, fixture.names.plain);
  assert.equal(parsed.findNodeByName('__missing__'), null);
  assert.equal(parsed.findNodesByType('cc.PrefabInstance').length, 1);
});

test('write helpers: 识别缩进和末尾换行', () => {
  assert.equal(detectIndent('[\n  {\n    "a": 1\n  }\n]\n'), 2);
  assert.equal(detectIndent('[\n    {\n        "a": 1\n    }\n]\n'), 4);
  assert.equal(detectTrailingNewline('foo\n'), true);
  assert.equal(detectTrailingNewline('foo'), false);
  assert.equal(detectTrailingNewline(''), false);
});

test('writePrefab: 无修改写回时保留缩进和末尾换行', (t) => {
  const fixture = createFixtureProject(t, 'format');
  const parsed = parsePrefab(fixture.hostPath);
  const originalIndent = detectIndent(parsed.raw);
  const originalTrailing = detectTrailingNewline(parsed.raw);

  writePrefab(fixture.hostPath, parsed.elements, parsed.raw);

  const written = fs.readFileSync(fixture.hostPath, 'utf8');
  assert.equal(detectIndent(written), originalIndent);
  assert.equal(detectTrailingNewline(written), originalTrailing);
});

test('parse/write: 普通节点字段修改可精确往返', (t) => {
  const fixture = createFixtureProject(t, 'ordinary-roundtrip');
  const parsed = parsePrefab(fixture.hostPath);
  const node = parsed.findNodeByName(fixture.names.plain);
  const beforeLength = parsed.elements.length;
  const beforeY = node._lpos.y;

  node._lpos.x = 321;
  writePrefab(fixture.hostPath, parsed.elements, parsed.raw);

  const reparsed = parsePrefab(fixture.hostPath);
  const changed = reparsed.findNodeByName(fixture.names.plain);
  assert.equal(changed._lpos.x, 321);
  assert.equal(changed._lpos.y, beforeY);
  assert.equal(reparsed.getRoot()._name, fixture.names.root);
  assert.equal(reparsed.elements.length, beforeLength);
});

test('parse/write: stub override 更新和新增可往返', (t) => {
  const fixture = createFixtureProject(t, 'override-roundtrip');
  const parsed = parseWithResolver(fixture.hostPath);
  const stubId = findNodeId(parsed, fixture.names.nested);
  const before = listOverrides(parsed, stubId);
  assert.ok(before.some((item) => item.propertyPath[0] === '_lpos'));

  setOverrideProperty(parsed, stubId, ['_lpos'], {
    __type__: 'cc.Vec3', x: 100, y: 200, z: 0,
  });
  setOverrideProperty(parsed, stubId, ['__fixture_prop'], 77);
  writePrefab(fixture.hostPath, parsed.elements, parsed.raw);

  const reparsed = parseWithResolver(fixture.hostPath);
  const overrides = listOverrides(reparsed, stubId);
  const position = overrides.find((item) => item.propertyPath[0] === '_lpos');
  const custom = overrides.find((item) => item.propertyPath[0] === '__fixture_prop');
  assert.equal(position.value.x, 100);
  assert.equal(position.value.y, 200);
  assert.equal(custom.value, 77);
  assert.equal(overrides.length, before.length + 1);
});
