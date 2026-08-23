'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseAnimationClip,
  queryAnimationClip,
  createAnimationClip,
} = require('../src/index.js');

const TMP_DIRS = [];

after(() => {
  for (const dir of TMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

function makeTmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-animation-' + tag + '-'));
  TMP_DIRS.push(dir);
  return dir;
}

function officialStyleClip(events = []) {
  return [
    {
      __type__: 'cc.AnimationClip',
      _name: 'Easing_Linear',
      _objFlags: 0,
      _native: '',
      sample: 60,
      speed: 1,
      wrapMode: 2,
      _duration: 1,
      _hash: 3157329513,
      _tracks: [{ __id__: 1 }],
      _events: events,
      _exoticAnimation: null,
    },
    {
      __type__: 'cc.animation.UntypedTrack',
      _binding: {
        __type__: 'cc.animation.TrackBinding',
        path: { __id__: 2 },
      },
      _channels: [{ __id__: 3 }, { __id__: 5 }],
    },
    {
      __type__: 'cc.animation.TrackPath',
      _paths: ['position'],
    },
    {
      __type__: 'cc.animation.UntypedTrackChannel',
      _curve: { __id__: 4 },
      property: 'x',
    },
    {
      __type__: 'cc.RealCurve',
      _times: [0, 1],
      _values: [
        { __type__: 'cc.RealKeyframeValue', interpolationMode: 0, value: -200, easingMethod: 0 },
        { __type__: 'cc.RealKeyframeValue', interpolationMode: 0, value: 200, easingMethod: 0 },
      ],
      preExtrapolation: 1,
      postExtrapolation: 1,
    },
    {
      __type__: 'cc.animation.UntypedTrackChannel',
      _curve: { __id__: 6 },
      property: 'y',
    },
    {
      __type__: 'cc.RealCurve',
      _times: [0, 1],
      _values: [
        { __type__: 'cc.RealKeyframeValue', interpolationMode: 0, value: 0, easingMethod: 0 },
        { __type__: 'cc.RealKeyframeValue', interpolationMode: 0, value: 0, easingMethod: 0 },
      ],
      preExtrapolation: 1,
      postExtrapolation: 1,
    },
  ];
}

function writeOfficialStyleFixture(tag, events) {
  const filePath = path.join(makeTmpDir(tag), 'Easing_Linear.anim');
  fs.writeFileSync(filePath, JSON.stringify(officialStyleClip(events), null, 2) + '\n', 'utf8');
  return filePath;
}

function minimalCreateSpec() {
  return {
    name: 'position-loop',
    duration: 1,
    sample: 60,
    speed: 1,
    wrapMode: 'loop',
    tracks: [
      {
        property: 'position',
        channels: [
          {
            property: 'x',
            keyframes: [
              { time: 0, value: -200, interpolation: 'linear' },
              { time: 1, value: 200, interpolation: 'linear' },
            ],
          },
          {
            property: 'y',
            keyframes: [
              { time: 0, value: 0 },
              { time: 1, value: 0 },
            ],
          },
        ],
      },
    ],
  };
}

test('parseAnimationClip accepts a real Creator 3.8 UntypedTrack shape', () => {
  const filePath = writeOfficialStyleFixture('parse');
  const data = parseAnimationClip(filePath);

  assert.equal(data.clip.__type__, 'cc.AnimationClip');
  assert.equal(data.clip._name, 'Easing_Linear');
  assert.equal(data.resolveRef(data.clip._tracks[0]).__type__, 'cc.animation.UntypedTrack');
});

test('queryAnimationClip normalizes position channels and real keyframes', () => {
  const filePath = writeOfficialStyleFixture('query');
  const result = queryAnimationClip(filePath);

  assert.equal(result.type, 'cc.AnimationClip');
  assert.equal(result.name, 'Easing_Linear');
  assert.equal(result.duration, 1);
  assert.equal(result.tracks.length, 1);
  assert.deepEqual(result.tracks[0].path, { property: 'position' });
  assert.deepEqual(
    result.tracks[0].channels.map((channel) => channel.property),
    ['x', 'y']
  );
  assert.deepEqual(
    result.tracks[0].channels[0].keyframes.map((keyframe) => [keyframe.time, keyframe.value]),
    [[0, -200], [1, 200]]
  );
  assert.deepEqual(result.events, []);
});

test('queryAnimationClip exposes AnimationClip events without changing params', () => {
  const expected = [{
    frame: 1.0166666666666666,
    func: 'AnimationEventTest',
    params: ['接收到动画事件', 7, { source: 'fixture' }],
  }];
  const filePath = writeOfficialStyleFixture('events', expected);

  assert.deepEqual(queryAnimationClip(filePath).events, expected);
});

test('createAnimationClip writes a queryable clip without overwriting an existing file', () => {
  const dir = makeTmpDir('create');
  const filePath = path.join(dir, 'position-loop.anim');
  const result = createAnimationClip(filePath, minimalCreateSpec());

  assert.equal(result.created, true);
  assert.equal(result.filePath, filePath);
  assert.equal(result.clip.name, 'position-loop');
  assert.equal(result.clip.wrapMode, 2);
  assert.deepEqual(
    result.clip.tracks[0].channels[0].keyframes.map((keyframe) => keyframe.value),
    [-200, 200]
  );
  assert.throws(
    () => createAnimationClip(filePath, minimalCreateSpec()),
    /已存在/
  );
});

test('createAnimationClip rejects non-increasing and out-of-range keyframe times', () => {
  const dir = makeTmpDir('invalid-times');
  const nonIncreasing = minimalCreateSpec();
  nonIncreasing.tracks[0].channels[0].keyframes[1].time = 0;
  assert.throws(
    () => createAnimationClip(path.join(dir, 'non-increasing.anim'), nonIncreasing),
    /严格递增/
  );

  const outOfRange = minimalCreateSpec();
  outOfRange.tracks[0].channels[0].keyframes[1].time = 2;
  assert.throws(
    () => createAnimationClip(path.join(dir, 'out-of-range.anim'), outOfRange),
    /duration/
  );
});

test('createAnimationClip validates destination and leaves no partial file on failure', () => {
  const dir = makeTmpDir('destination');
  const invalidExtension = path.join(dir, 'position-loop.json');
  assert.throws(
    () => createAnimationClip(invalidExtension, minimalCreateSpec()),
    /\.anim/
  );
  assert.equal(fs.existsSync(invalidExtension), false);

  const missingParent = path.join(dir, 'missing', 'position-loop.anim');
  assert.throws(
    () => createAnimationClip(missingParent, minimalCreateSpec()),
    /父目录不存在/
  );
  assert.equal(fs.existsSync(missingParent), false);
});
