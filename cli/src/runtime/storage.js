'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { fault } = require('./identity');

function privatePath(filename, directory) {
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw fault('UNSAFE_STATE_PATH', 'Invalid state path: ' + filename);
    if (process.platform === 'win32') {
        // File mode does not protect Windows state. Inspect effective explicit/inherited grants by SID.
        const command = "$ErrorActionPreference='Stop'; $p='" + filename.replace(/'/g, "''") + "'; $a=Get-Acl -LiteralPath $p; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $bad=@($a.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin @($u,'S-1-5-18','S-1-5-32-544') }); if ($bad.Count -gt 0) { exit 1 }";
        try { cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { timeout: 5000, stdio: 'ignore' }); }
        catch (_) { throw fault('STATE_NOT_PRIVATE', 'Cannot verify private Windows ACL: ' + filename); }
    } else if (stat.uid !== process.getuid() || (stat.mode & 0o077)) {
        throw fault('STATE_NOT_PRIVATE', 'State must be owned by the current user and private: ' + filename);
    }
    return stat;
}
function directory(filename) {
    if (!fs.existsSync(filename)) {
        const parent = path.dirname(filename);
        if (!fs.existsSync(parent)) directory(parent);
        try { fs.mkdirSync(filename, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        syncDirectory(parent);
    }
    privatePath(filename, true);
    return filename;
}
function syncDirectory(filename) {
    let fd;
    try { fd = fs.openSync(filename, 'r'); fs.fsyncSync(fd); }
    catch (_) { throw fault('DURABILITY_UNAVAILABLE', 'Cannot fsync directory: ' + filename); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
function publish(filename, value, replace = false) {
    directory(path.dirname(filename));
    const temporary = path.join(path.dirname(filename), '.pending-' + crypto.randomUUID());
    let fd;
    try {
        const bytes = Buffer.from(JSON.stringify(value));
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        privatePath(temporary, false);
        if (replace) fs.renameSync(temporary, filename);
        else {
            try { fs.linkSync(temporary, filename); }
            catch (error) { if (error.code === 'EEXIST') return false; throw error; }
        }
        syncDirectory(path.dirname(filename));
        return true;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}
function read(filename) {
    try { privatePath(filename, false); return JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT') return null;
        throw fault('STATE_CORRUPT', 'Cannot verify state file: ' + filename);
    }
}
function remove(filename) { fs.unlinkSync(filename); syncDirectory(path.dirname(filename)); }
module.exports = { privatePath, directory, syncDirectory, publish, read, remove };
