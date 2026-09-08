// Executed by macOS's built-in JavaScript for Automation, not by Node.
// Apple's PROC_PIDTBSDINFO (flavor 3) includes microsecond process start time.
function run(argv) {
    ObjC.import('Foundation');
    ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'uint64_t', 'void *', 'int']]);
    var pid = Number(argv[0]);
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid PID');
    var data = $.NSMutableData.dataWithLength(136);
    if ($.proc_pidinfo(pid, 3, 0, data.mutableBytes, 136) !== 136) throw new Error('Cannot obtain full BSD process identity');
    return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}
