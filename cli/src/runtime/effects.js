'use strict';

// This classification is shared by forwarding and execution. Unknown tools are never read-only.
const QUERY = new Set(['scene_query_node_tree', 'scene_query_node', 'asset_query_assets', 'asset_query_info',
    'asset_query_url', 'asset_query_uuid', 'preview_query_url', 'local_get_status', 'local_list_worktrees',
    'prefab_query', 'animation_query', 'router_list_editors', 'editor_wait_ready', 'operation_status', 'local_operation_status']);
const LIFECYCLE = new Set(['local_reload_package', 'editor_spawn', 'editor_restart', 'editor_kill', 'cli_open', 'cli_build']);
const MANAGEMENT = new Set(['operation_reconcile', 'offline_recover']);
const PREVIEWABLE = new Set(['prefab_edit', 'prefab_batch', 'animation_create', 'offline_recover']);
function classify(name, args = {}) {
    if (QUERY.has(name) || name === 'meta_fix' || PREVIEWABLE.has(name) && args.dryRun === true) return 'query';
    if (MANAGEMENT.has(name)) return 'management';
    return LIFECYCLE.has(name) ? 'lifecycle' : 'mutation';
}
module.exports = { classify };
