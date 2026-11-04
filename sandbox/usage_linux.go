//go:build linux

package sandbox

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// linuxUserHZ is the kernel's fixed USER_HZ scale for the CPU counters in
// /proc/<pid>/stat (utime and stime are in clock ticks).
const linuxUserHZ = 100

// platformSnapshot captures the host's whole process table.
var platformSnapshot snapshotFunc = platformProcs

// usageAccountingAvailable reports that this platform can account a process
// domain's resident memory and CPU time.
func usageAccountingAvailable() bool { return true }

// platformProcs snapshots every process from /proc: parent, process group,
// start time, CPU time, and resident pages from /proc/<pid>/stat. Processes
// that vanish mid-snapshot are skipped; only an unreadable /proc is an
// error.
func platformProcs() ([]procInfo, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, fmt.Errorf("sandbox: enumerate processes: %w", err)
	}
	procs := make([]procInfo, 0, len(entries))
	numeric, parsed := 0, 0
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 {
			continue
		}
		numeric++
		data, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
		if err != nil {
			continue // vanished mid-snapshot
		}
		info, ok := parseProcStat(pid, string(data))
		if !ok {
			continue
		}
		parsed++
		procs = append(procs, info)
	}
	if numeric > 0 && parsed == 0 {
		// Everything listed, nothing readable: the accounting itself is
		// broken, and zero usage must never pass for it.
		return nil, errors.New("sandbox: no process could be inspected for resource accounting")
	}
	return procs, nil
}

// parseProcStat parses one /proc/<pid>/stat line. The comm field may contain
// spaces and parentheses, so the fields after the last ')' carry state (3),
// ppid (4), pgrp (5), utime (14), stime (15), starttime (22), and the
// resident page count (24) at fixed offsets in the tail.
func parseProcStat(pid int, stat string) (procInfo, bool) {
	cut := strings.LastIndex(stat, ")")
	if cut < 0 {
		return procInfo{}, false
	}
	fields := strings.Fields(stat[cut+1:])
	if len(fields) < 22 {
		return procInfo{}, false
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return procInfo{}, false
	}
	pgid, err := strconv.Atoi(fields[2])
	if err != nil {
		return procInfo{}, false
	}
	utime, err := strconv.ParseInt(fields[11], 10, 64)
	if err != nil {
		return procInfo{}, false
	}
	stime, err := strconv.ParseInt(fields[12], 10, 64)
	if err != nil {
		return procInfo{}, false
	}
	start, err := strconv.ParseInt(fields[19], 10, 64)
	if err != nil {
		return procInfo{}, false
	}
	rss, err := strconv.ParseInt(fields[21], 10, 64)
	if err != nil {
		return procInfo{}, false
	}
	var resident int64
	if rss > 0 {
		resident = rss * int64(os.Getpagesize())
	}
	cpu := time.Duration(utime+stime) * time.Second / linuxUserHZ
	return procInfo{
		pid:      pid,
		ppid:     ppid,
		pgid:     pgid,
		start:    start,
		zombie:   fields[0] == "Z",
		resident: resident,
		cpu:      cpu,
	}, true
}

// processCwd reports one process's working directory — the fingerprint that
// keeps a daemonized child of this execution discoverable after it has left
// the process group and been reparented.
func processCwd(pid int) (string, bool) {
	target, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "cwd"))
	if err != nil {
		return "", false
	}
	return target, true
}

// killProc SIGKILLs one process; a process already gone is success. It is a
// variable so tests can record kills instead of signaling real processes.
var killProc = func(pid int) {
	_ = syscall.Kill(pid, syscall.SIGKILL) // ESRCH: already gone
}
