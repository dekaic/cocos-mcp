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
    for (var cursor = 0; cursor < queue.length; cursor++) {
        var node = queue[cursor];
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

function findComponent(uuid) {
    var scene = cc.director.getScene();
    if (!scene) return null;
    var queue = [scene];
    for (var cursor = 0; cursor < queue.length; cursor++) {
        var node = queue[cursor];
        var components = node.components || [];
        for (var i = 0; i < components.length; i++) {
            if (components[i].uuid === uuid) return components[i];
        }
        Array.prototype.push.apply(queue, node.children);
    }
    return null;
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
    querySceneState() {
        var scene = cc.director.getScene();
        if (!scene) throw new Error('scene is not loaded');
        return { uuid: scene.uuid, name: scene.name };
    },

    queryNodeTree(uuid) {
        var scene = cc.director.getScene();
        if (!scene) throw new Error('scene is not loaded');
        return describeNodeTree(uuid ? requireNode(uuid, 'node') : scene);
    },

    queryNodeContext(uuid) {
        var node = requireNode(uuid, 'node');
        return {
            uuid: node.uuid,
            parentUuid: node.parent ? node.parent.uuid : null,
            componentUuids: (node.components || []).map(function (component) { return component.uuid; }),
        };
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
        var oldParentUuid = node.parent.uuid;
        node.removeFromParent();
        node.destroy();
        if (findNode(options.uuid)) throw new Error('remove node postcondition failed: ' + options.uuid);
        return { uuid: options.uuid, oldParentUuid: oldParentUuid, removed: true };
    },

    reparentNode(options) {
        if (!options || !options.uuid || !options.parentUuid) {
            throw new Error('uuid and parentUuid are required');
        }

        var node = requireNode(options.uuid, 'node');
        var parent = requireNode(options.parentUuid, 'parent');
        if (node === parent) throw new Error('node cannot be its own parent');
        for (var ancestor = parent; ancestor; ancestor = ancestor.parent) {
            if (ancestor === node) throw new Error('node cannot be reparented under its own descendant');
        }
        node.setParent(parent);
        applyNodeOptions(node, options);
        if (node.parent !== parent) throw new Error('reparent postcondition failed: ' + node.uuid);
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
        // Cocos destroy() 在帧末才完成；strictMode=true 会把已进入 ToDestroy 队列的对象视为无效。
        if (cc.isValid(component, true)) throw new Error('remove component postcondition failed: ' + options.component);
        return { uuid: node.uuid, component: options.component, componentUuid: component.uuid, removed: true };
    },

    createComponent(options) {
        if (!options || !options.uuid || !options.component) {
            throw new Error('uuid and component are required');
        }
        var node = requireNode(options.uuid, 'node');
        var ctor = cc.js.getClassByName(options.component);
        if (!ctor && options.component.indexOf('cc.') === 0) {
            ctor = cc[options.component.slice(3)];
        }
        if (!ctor || !cc.js.isChildClassOf(ctor, cc.Component)) {
            throw new Error('component class not found: ' + options.component);
        }
        var component = node.addComponent(ctor);
        if (!component) throw new Error('failed to create component: ' + options.component);
        return {
            changed: true,
            nodeUuid: node.uuid,
            componentUuid: component.uuid,
            component: options.component,
        };
    },

    executeComponentMethod(options) {
        if (!options || !options.uuid || !options.name) {
            throw new Error('uuid and name are required');
        }
        var component = findComponent(options.uuid);
        if (!component) throw new Error('component not found: ' + options.uuid);
        var method = component[options.name];
        if (typeof method !== 'function') {
            throw new Error('component method not found: ' + options.name);
        }
        var result = method.apply(component, Array.isArray(options.args) ? options.args : []);
        return { executed: true, componentUuid: component.uuid, name: options.name, result: result };
    },
};
