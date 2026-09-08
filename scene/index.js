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

function findComponent(uuid) {
    if (!uuid) return null;

    var scene = cc.director.getScene();
    if (!scene) return null;

    var queue = [scene];
    while (queue.length > 0) {
        var node = queue.shift();
        var components = node.components || [];
        for (var i = 0; i < components.length; i++) {
            if (components[i] && components[i].uuid === uuid) return components[i];
        }
        Array.prototype.push.apply(queue, node.children || []);
    }
    return null;
}

function requireComponent(uuid) {
    var component = findComponent(uuid);
    if (!component) throw new Error('component not found: ' + uuid);
    return component;
}

function requireComponentMethod(component, name) {
    if (typeof name !== 'string' || !name) {
        throw new Error('method name must be a non-empty string');
    }
    var owner = component;
    var descriptor;
    while (owner && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(owner, name);
        owner = Object.getPrototypeOf(owner);
    }
    // Validation must not invoke user-defined accessors before execution is admitted.
    var method = descriptor && descriptor.value;
    if (typeof method !== 'function') throw new Error('method not found: ' + name);
    return method;
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
    validateComponentMethod(options) {
        if (!options || typeof options.uuid !== 'string' || !options.uuid) {
            throw new Error('component uuid must be a non-empty string');
        }
        if (options.args !== undefined && !Array.isArray(options.args)) {
            throw new Error('args must be an array');
        }

        var component = requireComponent(options.uuid);
        requireComponentMethod(component, options.name);
        return { uuid: options.uuid, name: options.name };
    },

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

    async instantiatePrefab(options) {
        if (!options || !options.parentUuid || !options.prefabUuid) {
            throw new Error('parentUuid and prefabUuid are required');
        }

        var parent = requireNode(options.parentUuid, 'parent');
        var prefab = await new Promise(function (resolve, reject) {
            cc.assetManager.loadAny(options.prefabUuid, function (error, asset) {
                if (error) {
                    reject(new Error('failed to load prefab ' + options.prefabUuid + ': ' + error.message));
                    return;
                }
                resolve(asset);
            });
        });
        if (!(prefab instanceof cc.Prefab)) {
            throw new Error('asset is not a cc.Prefab: ' + options.prefabUuid);
        }

        var node = cc.instantiate(prefab);
        node.setParent(parent);
        if (options.position) {
            node.setPosition(options.position.x || 0, options.position.y || 0, options.position.z || 0);
        }
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
