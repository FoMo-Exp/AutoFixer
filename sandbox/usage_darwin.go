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

// procInfoCallPIDInfo is the __proc_info call number libproc's proc_pidinfo(3)
// dispatches on. The raw syscall is
// __proc_info(callnum, pid, flavor, arg, buffer, buffersize).
const procInfoCallPIDInfo = 2

// procPidTaskInfo is the proc_pidinfo(3) flavor carrying procTaskInfo.
const procPidTaskInfo = 4

// usageAccountingAvailable reports that this platform can account a process
// domain's resident memory and CPU time.
func usageAccountingAvailable() bool { return true }

// platformProcs snapshots every process: identity (pid, ppid, pgid) from
// kern.proc, usage from proc_pidinfo(PROC_PIDTASKINFO). Processes that vanish
// mid-snapshot are skipped; only a failing enumeration is an error.
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
			pid:  int(entry.Proc.P_pid),
			ppid: int(entry.Eproc.Ppid),
			pgid: int(entry.Eproc.Pgid),
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

// killProc SIGKILLs one process; a process already gone is success.
func killProc(pid int) {
	_ = syscall.Kill(pid, syscall.SIGKILL) // ESRCH: already gone
}
