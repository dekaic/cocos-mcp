'use strict';
const fs = require('fs');
const cp = require('child_process');
const { canonicalProject, processIdentity, fault } = require('./identity');

// OS inventory is required even when no extension is registered. A missing heartbeat is not exit evidence.
function editorProcesses() {
    let rows;
    try {
        if (process.platform === 'win32') {
            const raw = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'CocosCreator.exe' } | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress"],
            { encoding: 'utf8', timeout: 10000 });
            const parsed = raw.trim() ? JSON.parse(raw) : [];
            rows = (Array.isArray(parsed) ? parsed : [parsed]).map(p => ({ pid: p.ProcessId, command: p.CommandLine }));
        } else {
            rows = cp.execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 })
                .split('\n').map(line => /^\s*(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
                .map(match => ({ pid: Number(match[1]), command: match[2] }))
                .filter(p => {
                    const executable = p.command.split(/\s+--?[a-zA-Z]/)[0].replace(/^"|"$/g, '');
                    return /\/CocosCreator$/.test(executable) && fs.existsSync(executable) && !/\s--type=/.test(p.command);
                });
        }
    } catch (_) { throw fault('PROCESS_INVENTORY_UNAVAILABLE', 'Cannot verify Creator process inventory; dangerous operations are unavailable'); }
    return rows.map(row => {
        if (typeof row.command !== 'string') throw fault('PROCESS_INVENTORY_UNAVAILABLE', 'Cannot inspect Creator command line for PID ' + row.pid);
        // ps does not preserve shell quoting. Creator places the project after --project; stop only at a subsequent option.
        const match = /(?:^|\s)--project(?:=|\s+)(.*?)(?=\s+--[a-zA-Z]|$)/.exec(row.command);
        let projectPath = null;
        if (match) {
            const value = match[1].trim().replace(/^(["'])(.*)\1$/, '$2');
            try { projectPath = canonicalProject(value); }
            catch (_) { throw fault('PROCESS_PROJECT_UNVERIFIED', 'Cannot verify Creator project for PID ' + row.pid); }
        }
        const owner = processIdentity(row.pid);
        return owner && { ...owner, projectPath };
    }).filter(Boolean);
}
function forProject(projectPath) {
    const canonical = canonicalProject(projectPath);
    const processes = editorProcesses();
    if (processes.some(p => !p.projectPath)) throw fault('PROCESS_PROJECT_UNVERIFIED', 'A Creator process has no verifiable project; close or identify it before offline writes');
    return processes.filter(p => p.projectPath === canonical);
}
function assertClosed(projectPath) {
    const processes = forProject(projectPath);
    if (processes.length) throw fault('CREATOR_MUST_BE_CLOSED', 'Close the target Creator explicitly before an offline commit or recovery', { processes });
    return { projectPath: canonicalProject(projectPath), checkedAt: new Date().toISOString(), processes: [] };
}
module.exports = { editorProcesses, forProject, assertClosed };
