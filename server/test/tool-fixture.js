'use strict';

const assert = require('node:assert/strict');
const { defineTools } = require('../tools.js');

function makeTools(overrides) {
    overrides = overrides || {};
    return defineTools({
        msg: overrides.msg || async function () {},
        local: Object.assign({
            getPreviewUrl: async function () { return ''; },
            doRefreshAssets: async function () {},
            doReloadScene: async function () {},
            listWorktrees: function () { return []; },
            openDevDir: function () { return ''; },
            cleanDevDir: function () { return []; },
            getStatus: async function () { return {}; },
            reloadPackage: function () {},
            fixMeta: function () {},
        }, overrides.local || {}),
    });
}

function findTool(tools, name) {
    const tool = tools.find(function (item) { return item.name === name; });
    assert.ok(tool, name + ' is registered');
    return tool;
}

module.exports = { makeTools, findTool };
