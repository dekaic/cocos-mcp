'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { projectIdForPath } = require('../../shared/project-id.js');
const { buildProjectScopedToolList } = require('../src/project-tools.js');
const { toolListSignature } = require('../src/tool-list-signature.js');

function editor(shortName) {
    return {
        shortName,
        tools: [{
            name: 'scene_query_node',
            description: 'query node',
            inputSchema: {
                type: 'object',
                properties: { uuid: { type: 'string' } },
                required: ['uuid'],
            },
        }],
    };
}

test('projectId is stable for canonical and symlinked project paths', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-project-id-'));
    const link = root + '-link';
    t.after(() => {
        try { fs.unlinkSync(link); } catch (_) {}
        fs.rmSync(root, { recursive: true, force: true });
    });
    fs.symlinkSync(root, link, 'dir');
    assert.equal(projectIdForPath(root), projectIdForPath(link));
    assert.match(projectIdForPath(root), /^project_[a-f0-9]{16}$/);
});

test('project-scoped tool list does not duplicate schemas per editor', () => {
    const tools = buildProjectScopedToolList([editor('two-d'), editor('three-d')]);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'scene_query_node');
    assert.ok(tools[0].inputSchema.required.includes('projectId'));
    assert.ok(tools[0].inputSchema.required.includes('uuid'));
});

test('tool list signature is unchanged when an identical editor joins', () => {
    assert.equal(
        toolListSignature([editor('two-d')]),
        toolListSignature([editor('two-d'), editor('three-d')])
    );
});

test('mixed editor versions merge required fields without duplicating the tool', () => {
    const oldEditor = editor('old');
    const newEditor = editor('new');
    newEditor.tools[0].inputSchema.properties.operationId = { type: 'string', minLength: 8 };
    newEditor.tools[0].inputSchema.required.push('operationId');

    const tools = buildProjectScopedToolList([oldEditor, newEditor]);
    assert.equal(tools.length, 1);
    assert.ok(tools[0].inputSchema.properties.operationId);
    assert.deepEqual(
        new Set(tools[0].inputSchema.required),
        new Set(['projectId', 'uuid', 'operationId'])
    );
});
