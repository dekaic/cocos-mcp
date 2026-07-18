'use strict';

var path = require('path');
module.paths.push(path.join(Editor.App.path, 'node_modules'));

var cc = require('cc');

function findNode(uuid) {
    if (!uuid) return null;

    var scene = cc.director.getScene();
    if (!scene) return null;
    if (scene.uuid === uuid) return scene;

    var queue = scene.children.slice();
    while (queue.length > 0) {
        var node = queue.shift();
        if (node.uuid === uuid) return node;
        Array.prototype.push.apply(queue, node.children);
    }
    return null;
}

function requireNode(uuid, label) {
    var node = findNode(uuid);
    if (!node) throw new Error((label || 'node') + ' not found: ' + uuid);
    return node;
}

function applyNodeOptions(node, options) {
    if (options.position) {
        node.setPosition(options.position.x || 0, options.position.y || 0, options.position.z || 0);
    }
    if (typeof options.active === 'boolean') node.active = options.active;
    if (typeof options.name === 'string' && options.name) node.name = options.name;
}

function describeNodeTree(node) {
    return {
        uuid: node.uuid,
        name: node.name,
        active: node.active,
        layer: node.layer,
        children: node.children.map(describeNodeTree),
    };
}

exports.methods = {
    queryNodeTree(uuid) {
        var scene = cc.director.getScene();
        if (!scene) throw new Error('scene is not loaded');
        return describeNodeTree(uuid ? requireNode(uuid, 'node') : scene);
    },

    addNode(options) {
        if (!options || !options.parentUuid) throw new Error('parentUuid is required');
        if (!options.name) throw new Error('name is required');

        var parent = requireNode(options.parentUuid, 'parent');
        var node = new cc.Node(options.name);
        node.setParent(parent);
        applyNodeOptions(node, options);
        return { uuid: node.uuid, name: node.name, parentUuid: parent.uuid };
    },

    cloneNode(options) {
        if (!options || !options.sourceUuid || !options.parentUuid) {
            throw new Error('sourceUuid and parentUuid are required');
        }

        var source = requireNode(options.sourceUuid, 'source');
        var parent = requireNode(options.parentUuid, 'parent');
        var node = cc.instantiate(source);
        node.setParent(parent);
        applyNodeOptions(node, options);
        return { uuid: node.uuid, name: node.name, parentUuid: parent.uuid };
    },

    removeNode(options) {
        if (!options || !options.uuid) throw new Error('uuid is required');

        var node = requireNode(options.uuid, 'node');
        if (!node.parent) throw new Error('scene root cannot be removed');
        node.destroy();
        return { uuid: options.uuid, removed: true };
    },

    reparentNode(options) {
        if (!options || !options.uuid || !options.parentUuid) {
            throw new Error('uuid and parentUuid are required');
        }

        var node = requireNode(options.uuid, 'node');
        var parent = requireNode(options.parentUuid, 'parent');
        if (node === parent) throw new Error('node cannot be its own parent');
        node.setParent(parent);
        applyNodeOptions(node, options);
        return { uuid: node.uuid, name: node.name, parentUuid: parent.uuid };
    },

    removeComponent(options) {
        if (!options || !options.uuid || !options.component) {
            throw new Error('uuid and component are required');
        }

        var node = requireNode(options.uuid, 'node');
        var component = node.getComponent(options.component);
        if (!component) throw new Error('component not found: ' + options.component);
        component.destroy();
        return { uuid: node.uuid, component: options.component, removed: true };
    },
};
