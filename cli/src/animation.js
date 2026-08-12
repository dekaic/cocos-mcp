'use strict';

const fs = require('fs');
const path = require('path');
const { ref } = require('./primitives.js');
const {
  InterpolationMode,
  makeRealKeyframe,
  makeRealCurve,
  makeUntypedTrackChannel,
  makeHierarchyPath,
  makeComponentPath,
  makeTrackPath,
  makeUntypedTrack,
} = require('./anim-primitives.js');

const WRAP_MODES = Object.freeze({
  normal: 1,
  loop: 2,
  'ping-pong': 22,
  'ping-pong-loop': 36,
});

const INTERPOLATIONS = Object.freeze({
  linear: InterpolationMode.LINEAR,
  constant: InterpolationMode.CONSTANT,
  cubic: InterpolationMode.CUBIC,
});

function parseAnimationClip(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`parseAnimationClip: 读取失败（${filePath}）: ${e.message}`);
  }

  let elements;
  try {
    elements = JSON.parse(raw);
  } catch (e) {
    throw new Error(`parseAnimationClip: JSON 解析失败（${filePath}）: ${e.message}`);
  }
  if (!Array.isArray(elements)) {
    throw new Error(`parseAnimationClip: 顶层不是数组（${filePath}）`);
  }

  const clipId = elements.findIndex((element) => (
    element && element.__type__ === 'cc.AnimationClip'
  ));
  if (clipId < 0) {
    throw new Error(`parseAnimationClip: 未找到 cc.AnimationClip（${filePath}）`);
  }

  function resolveRef(refObject, context = '引用') {
    if (!refObject || !Number.isInteger(refObject.__id__)) {
      throw new Error(`parseAnimationClip: ${context} 不是有效 __id__ 引用`);
    }
    const element = elements[refObject.__id__];
    if (element === undefined) {
      throw new Error(`parseAnimationClip: ${context} __id__ ${refObject.__id__} 超出数组范围`);
    }
    return element;
  }

  return {
    raw,
    elements,
    clipId,
    clip: elements[clipId],
    resolveRef,
  };
}

function normalizeTrackPath(trackPath, data) {
  const result = {};
  const parts = trackPath && Array.isArray(trackPath._paths) ? trackPath._paths : [];

  for (const part of parts) {
    if (typeof part === 'string') {
      result.property = part;
      continue;
    }
    if (!part || !Number.isInteger(part.__id__)) continue;
    const resolved = data.resolveRef(part, 'TrackPath');
    if (resolved.__type__ === 'cc.animation.HierarchyPath') {
      result.nodePath = resolved.path;
    } else if (resolved.__type__ === 'cc.animation.ComponentPath') {
      result.component = resolved.component;
    }
  }

  return result;
}

function normalizeCurve(curve, channelId) {
  const times = Array.isArray(curve._times) ? curve._times : [];
  const values = Array.isArray(curve._values) ? curve._values : [];
  if (times.length !== values.length) {
    throw new Error(
      `queryAnimationClip: channel ${channelId} 的 _times 与 _values 长度不一致`
    );
  }

  const keyframes = times.map((time, index) => {
    const rawValue = values[index];
    if (rawValue && rawValue.__type__ === 'cc.RealKeyframeValue') {
      const keyframe = { time, value: rawValue.value };
      if (rawValue.interpolationMode !== undefined) {
        keyframe.interpolationMode = rawValue.interpolationMode;
      }
      if (rawValue.easingMethod !== undefined) {
        keyframe.easingMethod = rawValue.easingMethod;
      }
      return keyframe;
    }
    return { time, value: rawValue };
  });

  return {
    curveType: curve.__type__ || null,
    keyframes,
  };
}

function queryAnimationClip(filePath) {
  const data = parseAnimationClip(filePath);
  const clip = data.clip;
  const trackRefs = Array.isArray(clip._tracks) ? clip._tracks : [];

  const tracks = trackRefs.map((trackRef) => {
    const trackId = trackRef.__id__;
    const track = data.resolveRef(trackRef, 'AnimationClip._tracks');
    const pathRef = track._binding && track._binding.path;
    const trackPath = data.resolveRef(pathRef, `track ${trackId} binding.path`);
    const channelRefs = Array.isArray(track._channels)
      ? track._channels
      : (track._channel ? [track._channel] : []);
    const inferredNames = ['x', 'y', 'z', 'w'];

    const channels = channelRefs.map((channelRef, index) => {
      const channelId = channelRef.__id__;
      const channel = data.resolveRef(channelRef, `track ${trackId} channel`);
      const curve = data.resolveRef(channel._curve, `channel ${channelId} curve`);
      const normalized = normalizeCurve(curve, channelId);
      return {
        id: channelId,
        property: channel.property !== undefined
          ? channel.property
          : (channelRefs.length > 1 ? inferredNames[index] : null),
        curveType: normalized.curveType,
        keyframes: normalized.keyframes,
      };
    });

    return {
      id: trackId,
      type: track.__type__ || null,
      path: normalizeTrackPath(trackPath, data),
      channels,
    };
  });

  return {
    type: clip.__type__,
    name: clip._name,
    sample: clip.sample,
    speed: clip.speed,
    wrapMode: clip.wrapMode,
    duration: clip._duration,
    tracks,
  };
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`createAnimationClip: ${label} 必须是非空字符串`);
  }
  return value;
}

function requireFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`createAnimationClip: ${label} 必须是有限数字`);
  }
  return value;
}

function normalizeCreateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('createAnimationClip: clip 必须是对象');
  }

  const name = requireNonEmptyString(spec.name, 'clip.name');
  const duration = requireFiniteNumber(spec.duration, 'clip.duration');
  if (duration <= 0) {
    throw new Error('createAnimationClip: clip.duration 必须大于 0');
  }

  const sample = spec.sample === undefined ? 60 : spec.sample;
  if (!Number.isInteger(sample) || sample <= 0) {
    throw new Error('createAnimationClip: clip.sample 必须是正整数');
  }
  const speed = spec.speed === undefined ? 1 : requireFiniteNumber(spec.speed, 'clip.speed');
  const wrapModeName = spec.wrapMode === undefined ? 'normal' : spec.wrapMode;
  if (!Object.prototype.hasOwnProperty.call(WRAP_MODES, wrapModeName)) {
    throw new Error(`createAnimationClip: 不支持的 clip.wrapMode ${JSON.stringify(wrapModeName)}`);
  }
  if (!Array.isArray(spec.tracks) || spec.tracks.length === 0) {
    throw new Error('createAnimationClip: clip.tracks 必须是非空数组');
  }

  const tracks = spec.tracks.map((track, trackIndex) => {
    const label = `clip.tracks[${trackIndex}]`;
    if (!track || typeof track !== 'object' || Array.isArray(track)) {
      throw new Error(`createAnimationClip: ${label} 必须是对象`);
    }
    const property = requireNonEmptyString(track.property, `${label}.property`);
    const nodePath = track.nodePath === undefined
      ? undefined
      : requireNonEmptyString(track.nodePath, `${label}.nodePath`);
    const component = track.component === undefined
      ? undefined
      : requireNonEmptyString(track.component, `${label}.component`);
    if (!Array.isArray(track.channels) || track.channels.length === 0) {
      throw new Error(`createAnimationClip: ${label}.channels 必须是非空数组`);
    }

    const channelNames = new Set();
    const channels = track.channels.map((channel, channelIndex) => {
      const channelLabel = `${label}.channels[${channelIndex}]`;
      if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
        throw new Error(`createAnimationClip: ${channelLabel} 必须是对象`);
      }
      const channelProperty = requireNonEmptyString(
        channel.property,
        `${channelLabel}.property`
      );
      if (channelNames.has(channelProperty)) {
        throw new Error(`createAnimationClip: ${label} 存在重复 channel ${JSON.stringify(channelProperty)}`);
      }
      channelNames.add(channelProperty);
      if (!Array.isArray(channel.keyframes) || channel.keyframes.length === 0) {
        throw new Error(`createAnimationClip: ${channelLabel}.keyframes 必须是非空数组`);
      }

      let previousTime = -Infinity;
      const keyframes = channel.keyframes.map((keyframe, keyframeIndex) => {
        const keyframeLabel = `${channelLabel}.keyframes[${keyframeIndex}]`;
        if (!keyframe || typeof keyframe !== 'object' || Array.isArray(keyframe)) {
          throw new Error(`createAnimationClip: ${keyframeLabel} 必须是对象`);
        }
        const time = requireFiniteNumber(keyframe.time, `${keyframeLabel}.time`);
        const value = requireFiniteNumber(keyframe.value, `${keyframeLabel}.value`);
        if (time < 0 || time > duration) {
          throw new Error(
            `createAnimationClip: ${keyframeLabel}.time 必须在 0 到 clip.duration 之间`
          );
        }
        if (time <= previousTime) {
          throw new Error(`createAnimationClip: ${channelLabel} 的关键帧时间必须严格递增`);
        }
        previousTime = time;

        const interpolation = keyframe.interpolation === undefined
          ? 'linear'
          : keyframe.interpolation;
        if (!Object.prototype.hasOwnProperty.call(INTERPOLATIONS, interpolation)) {
          throw new Error(
            `createAnimationClip: 不支持的 ${keyframeLabel}.interpolation ${JSON.stringify(interpolation)}`
          );
        }
        const easingMethod = keyframe.easingMethod === undefined ? 0 : keyframe.easingMethod;
        if (!Number.isInteger(easingMethod) || easingMethod < 0) {
          throw new Error(`createAnimationClip: ${keyframeLabel}.easingMethod 必须是非负整数`);
        }
        return { time, value, interpolation, easingMethod };
      });
      return { property: channelProperty, keyframes };
    });
    return { nodePath, component, property, channels };
  });

  return {
    name,
    duration,
    sample,
    speed,
    wrapMode: WRAP_MODES[wrapModeName],
    tracks,
  };
}

function buildAnimationElements(spec) {
  const elements = [null];
  const trackIndices = [];

  for (const track of spec.tracks) {
    const pathParts = [];
    if (track.nodePath !== undefined) {
      const hierarchyIndex = elements.length;
      elements.push(makeHierarchyPath(track.nodePath));
      pathParts.push(ref(hierarchyIndex));
    }
    if (track.component !== undefined) {
      const componentIndex = elements.length;
      elements.push(makeComponentPath(track.component));
      pathParts.push(ref(componentIndex));
    }
    pathParts.push(track.property);

    const pathIndex = elements.length;
    elements.push(makeTrackPath(pathParts));
    const channelIndices = [];

    for (const channel of track.channels) {
      const curveIndex = elements.length;
      elements.push(makeRealCurve({
        times: channel.keyframes.map((keyframe) => keyframe.time),
        values: channel.keyframes.map((keyframe) => makeRealKeyframe({
          value: keyframe.value,
          interpolationMode: INTERPOLATIONS[keyframe.interpolation],
          easingMethod: keyframe.easingMethod,
        })),
      }));
      const channelIndex = elements.length;
      elements.push(makeUntypedTrackChannel(curveIndex, channel.property));
      channelIndices.push(channelIndex);
    }

    const trackIndex = elements.length;
    elements.push(makeUntypedTrack(pathIndex, channelIndices));
    trackIndices.push(trackIndex);
  }

  elements[0] = {
    __type__: 'cc.AnimationClip',
    _name: spec.name,
    _objFlags: 0,
    _native: '',
    sample: spec.sample,
    speed: spec.speed,
    wrapMode: spec.wrapMode,
    _duration: spec.duration,
    _tracks: trackIndices.map(ref),
    _events: [],
    _exoticAnimation: null,
  };
  return elements;
}

function writeNewAnimationClip(filePath, elements) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(elements, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
    });
    if (fs.existsSync(filePath)) {
      throw new Error(`目标文件已存在: ${filePath}`);
    }
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw e;
  }
}

function createAnimationClip(filePath, clipSpec) {
  if (typeof filePath !== 'string' || path.extname(filePath).toLowerCase() !== '.anim') {
    throw new Error('createAnimationClip: filePath 必须以 .anim 结尾');
  }
  if (fs.existsSync(filePath)) {
    throw new Error(`createAnimationClip: 目标文件已存在: ${filePath}`);
  }
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error(`createAnimationClip: 父目录不存在: ${parent}`);
  }

  const normalized = normalizeCreateSpec(clipSpec);
  writeNewAnimationClip(filePath, buildAnimationElements(normalized));
  return {
    created: true,
    filePath,
    clip: queryAnimationClip(filePath),
  };
}

module.exports = {
  WRAP_MODES,
  parseAnimationClip,
  queryAnimationClip,
  createAnimationClip,
};
