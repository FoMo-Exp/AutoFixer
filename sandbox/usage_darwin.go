//go:build darwin

package sandbox

import (
	"errors"
	"fmt"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// procTaskInfo mirrors darwin's struct proc_taskinfo (bsd/sys/proc_info.h):
// per-task virtual and resident size in bytes, and user and system time in
// nanoseconds.
type procTaskInfo struct {
	virtualSize   uint64
	residentSize  uint64
	totalUser     uint64
	totalSystem   uint64
	threadsUser   uint64
	threadsSystem uint64
	policy        int32
	faults        int32
	pageins       int32
	cowFaults     int32
	messagesSent  int32
	messagesRecvd int32
	syscallsMach  int32
	syscallsUnix  int32
	csw           int32
	threadnum     int32
	numrunning    int32
	priority      int32
}

// Mirrors of bsd/sys/proc_info.h's vinfo_stat / vnode_info /
// vnode_info_path / proc_vnodepathinfo, used only to read one process's
// working directory (the tail end of pvi_cdir's vip_path).
type vinfoStat struct {
	vstDev      uint32
	vstMode     uint16
	vstNlink    uint16
	vstIno      uint64
	vstUid      uint32
	vstGid      uint32
	vstAtime    int64
	vstAtimense int64
	vstMtime    int64
	vstMtimense int64
	vstCtime    int64
	vstCtimense int64
	vstBirth    int64
	vstBirthns  int64
	vstSize     int64
	vstBlocks   int64
	vstBlksize  int32
	vstFlags    uint32
	vstGen      uint32
	vstRdev     uint32
	vstQspare   [2]int64
}

type vnodeInfo struct {
	viStat vinfoStat
	viType int32
	viPad  int32
	viFsid [2]int32
}

type vnodeInfoPath struct {
	vipVi   vnodeInfo
	vipPath [1024]byte
}

type procVnodepathinfo struct {
	pviCdir vnodeInfoPath
	pviRdir vnodeInfoPath
}

const (
	// procInfoCallPIDInfo is the __proc_info call number libproc's
	// proc_pidinfo(3) dispatches on. The raw syscall is
	// __proc_info(callnum, pid, flavor, arg, buffer, buffersize).
	procInfoCallPIDInfo = 2
	// procPidTaskInfo is the proc_pidinfo(3) flavor carrying procTaskInfo.
	procPidTaskInfo = 4
	// procPidVnodePathInfo is the flavor carrying procVnodepathinfo.
	procPidVnodePathInfo = 9
	// szomb is the SZOMB process state: awaiting collection by its parent.
	szomb = 5
)

// platformSnapshot captures the host's whole process table.
var platformSnapshot snapshotFunc = platformProcs

// usageAccountingAvailable reports that this platform can account a process
// domain's resident memory and CPU time.
func usageAccountingAvailable() bool { return true }

// platformProcs snapshots every process: identity (pid, ppid, pgid, start)
// from kern.proc, usage from proc_pidinfo(PROC_PIDTASKINFO). Processes that
// vanish mid-snapshot are skipped; only a failing enumeration is an error.
func platformProcs() ([]procInfo, error) {
	raw, err := unix.SysctlRaw("kern.proc.all")
	if err != nil {
		return nil, fmt.Errorf("sandbox: enumerate processes: %w", err)
	}
	stride := unix.SizeofKinfoProc
	size := int(unsafe.Sizeof(unix.KinfoProc{}))
	if stride <= 0 || size != stride || len(raw)%stride != 0 {
		return nil, fmt.Errorf("sandbox: unexpected kern.proc buffer size %d", len(raw))
	}
	count := len(raw) / stride
	procs := make([]procInfo, 0, count)
	inspected := 0
	for i := 0; i < count; i++ {
		// The sysctl buffer is a packed array of struct kinfo_proc. Copy
		// one entry into aligned typed storage before reading it.
		var entry unix.KinfoProc
		copy(unsafe.Slice((*byte)(unsafe.Pointer(&entry)), stride), raw[i*stride:(i+1)*stride])
		info := procInfo{
			pid:    int(entry.Proc.P_pid),
			ppid:   int(entry.Eproc.Ppid),
			pgid:   int(entry.Eproc.Pgid),
			start:  int64(entry.Proc.P_starttime.Sec)*int64(time.Second/time.Microsecond) + int64(entry.Proc.P_starttime.Usec),
			zombie: entry.Proc.P_stat == szomb,
		}
		if info.pid <= 0 {
			continue
		}
		if resident, cpu, ok := procTaskUsage(info.pid); ok {
			info.resident = resident
			info.cpu = cpu
			inspected++
		}
		procs = append(procs, info)
	}
	if count > 0 && inspected == 0 {
		// Everything enumerated, nothing inspectable: the accounting
		// itself is broken, and zero usage must never pass for it.
		return nil, errors.New("sandbox: no process could be inspected for resource accounting")
	}
	return procs, nil
}

// procTaskUsage reports one task's resident size in bytes and total CPU
// time. A task that cannot be inspected (vanished, not ours) is skipped.
func procTaskUsage(pid int) (int64, time.Duration, bool) {
	var info procTaskInfo
	n, _, errno := syscall.Syscall6(syscall.SYS_PROC_INFO,
		uintptr(procInfoCallPIDInfo), uintptr(pid), uintptr(procPidTaskInfo), 0,
		uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
	if errno != 0 || n == 0 {
		return 0, 0, false
	}
	cpu := time.Duration(info.totalUser+info.totalSystem) * time.Nanosecond
	return int64(info.residentSize), cpu, true
}

// processCwd reports one process's working directory. It is the fingerprint
// that keeps a daemonized child of this execution discoverable after it has
// left the process group and been reparented: the workspace directory is
// unique to one run, and a process working inside it belongs to that run.
func processCwd(pid int) (string, bool) {
	var info procVnodepathinfo
	n, _, errno := syscall.Syscall6(syscall.SYS_PROC_INFO,
		uintptr(procInfoCallPIDInfo), uintptr(pid), uintptr(procPidVnodePathInfo), 0,
		uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
	if errno != 0 || n == 0 {
		return "", false
	}
	raw := info.pviCdir.vipPath[:]
	if end := indexByte(raw, 0); end >= 0 {
		raw = raw[:end]
	}
	return string(raw), true
}

// indexByte is bytes.IndexByte without importing bytes for one call.
func indexByte(b []byte, c byte) int {
	for i := range b {
		if b[i] == c {
			return i
		}
	}
	return -1
}

// killProc SIGKILLs one process; a process already gone is success. It is a
// variable so tests can record kills instead of signaling real processes.
var killProc = func(pid int) {
	_ = syscall.Kill(pid, syscall.SIGKILL) // ESRCH: already gone
}
