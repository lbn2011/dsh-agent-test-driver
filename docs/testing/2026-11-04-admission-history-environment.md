# admission-history-conversion — execution-environment investigation (read-only)

STATUS: **INVESTIGATION ONLY — no acceptance result, no retry, no test, no build.**
This file records why the one authorised launcher attempt was refused at preflight
(`systemctl list-units` could not reach the system bus). It does not change the batch
verdict and does not produce any test evidence. The batch record stays
`2026-11-04-admission-history-conversion.md` (STATUS: REFUSED at preflight).

## 1. Authorisation and what was explicitly not done

The user approved **one** read-only environment investigation, not a retry. Within it:

- **one** lightweight read-only `bash` invocation (identity, PID 1, cgroup, namespace
  links, `/run` endpoint stats, `systemctl` path/version, bus env-var *presence* only);
- two file-tool reads (`/proc/1/comm`, `/proc/net/unix`);
- no runner invocation, no `systemd-run`, no `node`, no test, no build/install;
- no connection to, restart of, or reconfiguration of any production service; no
  permission change; no reinstall; no polling; no alternate execution path, no attempt to
  escape or route around the sandbox;
- no traversal of production configuration and nothing under `/root/.dsh`;
- no environment values printed — only whether each bus variable is set.

Exit codes are preserved below as printed by the invocation itself.

## 2. Method, and one methodological fact that shapes the whole record

Facts came from **two different execution contexts that do not share a PID namespace**:

| Source | View it represents |
| --- | --- |
| the single `bash` invocation | inside a sandbox whose PID 1 is `/usr/bin/bwrap` |
| the file tools (`read`) | a context where `/proc/1/comm` is `systemd` |

That difference is not a typo and it is not incidental — it is the central observation
(§4). Every fact below is therefore attributed to the context that produced it, and
nothing is stated as if it held in both.

## 3. Raw transcripts

### 3a. The one bash invocation — complete stdout, verbatim

Transcript (tool output; not written to a file on disk):

```
== identity ==
/root/dsh-ecosystem-spec
rc_pwd=0
uid=0(root) gid=0(root) groups=0(root)
rc_id=0

== pid1 / container hints ==
/usr/bin/bwrap
rc_pid1_exe=0
rc_run_systemd_system_dir_exists=0
rc_dockerenv_exists=1
rc_containerenv_exists=1
bash_pid=2

== self cgroup / namespaces (bash process) ==
0::/system.slice/dsh-web.service
total 0
lrwxrwxrwx 1 root root 0 Nov  4 03:09 cgroup -> cgroup:[4026531835]
lrwxrwxrwx 1 root root 0 Nov  4 03:09 ipc -> ipc:[4026531839]
lrwxrwxrwx 1 root root 0 Nov  4 03:09 mnt -> mnt:[4026532319]
lrwxrwxrwx 1 root root 0 Nov  4 03:09 net -> net:[4026531840]
lrwxrwxrwx 1 root root 0 Nov  4 03:09 pid -> pid:[4026532320]
lrwxrwxrwx 1 root root 0 Nov  4 03:09 pid_for_children -> pid:[4026532320]
lrwxrwxrwx 1 root root 0 Nov  4 03:09 time -> time:[4026531834]
lrwxrwxrwx 1 root root 0 Nov  4 03:09 time_for_children -> time:[4026531834]
lrwxrwxrwx 1 root root 0 Nov  4 03:09 user -> user:[4026531837]
lrwxrwxrwx 1 root root 0 Nov  4 03:09 uts -> uts:[4026531838]
rc_ls_self_ns=0

== system bus endpoints ==
/run/systemd/private type=socket mode=700 owner=root:root size=0
rc_stat_/run/systemd/private=0
/run/dbus/system_bus_socket type=socket mode=666 owner=root:root size=0
rc_stat_/run/dbus/system_bus_socket=0
/run/dbus type=directory mode=755 owner=root:root size=60
rc_stat_/run/dbus=0
/run/systemd type=directory mode=755 owner=root:root size=600
rc_stat_/run/systemd=0
rc_private_is_socket=0
rc_dbus_is_socket=0

== systemctl ==
/usr/bin/systemctl
rc_command_v_systemctl=0
systemd 257 (257.13-1~deb13u1)
+PAM +AUDIT +SELINUX +APPARMOR +IMA +IPE +SMACK +SECCOMP +GCRYPT -GNUTLS +OPENSSL +ACL +BLKID +CURL +ELFUTILS +FIDO2 +IDN2 -IDN +IPTC +KMOD +LIBCRYPTSETUP +LIBCRYPTSETUP_PLUGINS +LIBFDISK +PCRE2 +PWQUALITY +P11KIT +QRENCODE +TPM2 +BZIP2 +LZ4 +XZ +ZLIB +ZSTD +BPF_FRAMEWORK +BTF -XKBCOMMON -UTMP +SYSVINIT +LIBARCHIVE
rc_systemctl_version=0

== bus env presence only (no values) ==
DBUS_SYSTEM_BUS_ADDRESS=unset
SYSTEMD_HOST=unset
SYSTEMD_BUS_ADDRESS=unset
XDG_RUNTIME_DIR=unset
```

Two shell-side deviations from the "use `read` for text" rule are disclosed in §7: the
cgroup line used `printf` on `/proc/self/cgroup`, and namespace links used `ls -l`, both
because those objects belong to *the bash process itself* and no file tool can read another
process's `/proc/self`.

### 3b. File-tool read of `/proc/1/comm`

```
1: systemd
```

### 3c. File-tool match over `/proc/net/unix` (5 matching lines)

```
Line 15: 0000000057463efe: 00000002 00000000 00010000 0001 01  1871 /run/systemd/private
Line 29: 00000000eff9b77c: 00000003 00000000 00000000 0001 03  5471 /run/dbus/system_bus_socket
Line 53: 00000000f599a94c: 00000003 00000000 00000000 0001 03  4388 /run/dbus/system_bus_socket
Line 56: 00000000224d90ea: 00000002 00000000 00010000 0001 01  3695 /run/dbus/system_bus_socket
Line 76: 000000007b3d1add: 00000003 00000000 00000000 0001 03  4386 /run/dbus/system_bus_socket
```

Reading the state column: `01` = `SS_UNCONNECTED` (a listening socket), `03` =
`SS_CONNECTED`. So in that universe `/run/systemd/private` (inode 1871) and
`/run/dbus/system_bus_socket` both have live listeners. **Caveat:** this listing came from
the file-tool context, and `/proc/net/unix` is per-network-namespace; §5 explains why its
namespace ownership is *not* provable from the data collected.

## 4. Facts (separated from interpretation)

Observed, inside the bash sandbox:

1. The launcher's shell runs as `uid=0 gid=0`, `pwd=/root/dsh-ecosystem-spec`.
2. `PID 1` **in that PID namespace** is `/usr/bin/bwrap` (`readlink /proc/1/exe` rc=0).
   The bash process itself is `bash_pid=2` — i.e. the second process in a fresh namespace.
3. Namespace inodes: `mnt:[4026532319]` and `pid:[4026532320]` are both **non-initial**
   (freshly created), while `net:[4026531840]`, `ipc:[4026531839]`, `user:[4026531837]`,
   `uts:[4026531838]`, `cgroup:[4026531835]` are the **initial/root** namespace inodes.
   So the sandbox isolates mount + PID, and does **not** isolate networking.
4. cgroup: `0::/system.slice/dsh-web.service` — cgroup v2 unified hierarchy, and the
   sandboxed process is still accounted under the harness service's slice.
5. `/run/systemd/system` exists (`test -d` rc=0); `/.dockerenv` and `/run/.containerenv`
   are absent (rc=1 each) — no container-marker files.
6. `/run` endpoints, as seen inside the sandbox: `/run/systemd/private` is a **socket**,
   mode `700 root:root`; `/run/dbus/system_bus_socket` is a **socket**, mode `666`;
   `/run/dbus` and `/run/systemd` are directories mode 755. All `stat` calls rc=0. Both
   `test -S` checks rc=0. So the mount namespace does expose these socket *files*.
7. `systemctl` is `/usr/bin/systemctl`, `systemd 257 (257.13-1~deb13u1)`; both lookups
   rc=0.
8. `DBUS_SYSTEM_BUS_ADDRESS`, `SYSTEMD_HOST`, `SYSTEMD_BUS_ADDRESS`, `XDG_RUNTIME_DIR`
   are all **unset** — no environment override redirects the bus anywhere.

Observed, in the file-tool context:

9. `/proc/1/comm` is `systemd` — that context's PID 1 is systemd, not bwrap.

## 5. Interpretation (labelled as interpretation)

**5a. The session's shell is inside a bwrap PID namespace whose init is bwrap, and the
file tools are not.** Items 2 and 9 cannot both be true of one PID namespace. The
straightforward reading is that sandboxed execution and file-tool access run in different
PID (and mount) namespaces. Consequence: results from `read`/`grep` describe *a* system
view, not necessarily the sandboxed shell's view, and must not be quoted as if the shell
had seen them.

**5b. This is consistent with the observed failure mode** of the refused attempt:
`systemctl list-units` returned rc=1 with
`Failed to connect to system scope bus via local transport: No data available`
(recorded verbatim in `…/runs/20261103T190142Z-admission-history-conversion/preflight.txt`).
A system bus connection is not a socket-file-existence problem here — the socket file is
present and, per 3c, has a live listener somewhere. The likely mechanism is credential/
peer resolution across a PID-namespace boundary: the connecting process presents a PID that
the bus's systemd cannot resolve to a peer it knows, so the connection is not established
and sd-bus reports `ENODATA` ("No data available") rather than a plain refusal. This
explanation is **inference from the two facts above**, not something directly measured.

**5c. Consequence for the batch.** If 5b holds, no edit to `run.sh`/`payload.sh` can make
the competing-work preflight succeed in this execution context: the preflight is *required*
to read the unit table and to refuse when it cannot, and the bus is not reachable from a
PID namespace where systemd is not PID 1. The fix is an execution context, not a code
change — and choosing one is the Lead's call, not this record's.

**5d. Namespace ownership of 3c is unproven.** Because 3c came from the file-tool context
and `/proc/net/unix` is per-network-namespace, the listing may describe the file-tool
context's network namespace rather than the sandboxed shell's. The bash-side namespace
inodes suggest a shared (initial) network namespace, which would make the two listings
equivalent — but that is inference, and the inode identity of 1871 against the *sandbox's*
`/run/systemd/private` was **not** compared. Do not read 3c as "the sandbox can reach a
live system bus listener".

## 6. What this record does not establish

- nothing about whether the host's systemd is healthy, or about any service's state;
- nothing about the Loader run, the converter, or any admission behaviour;
- no test result, no TAP output, no envelope measurement, no gate sample — the batch
  record's "NOT OBSERVED" fields stay exactly as they are;
- no proof that networking is the (or the only) blocking layer, and no exhaustive
  enumeration of sandbox restrictions (seccomp filters, mount options were not probed);
- no claim that the earlier audit-agent deviations or this investigation constitute
  acceptance evidence — they do not.

## 7. Deviations disclosed

1. The `bash` tool was used at all: authorised explicitly for this read-only investigation.
2. Within it, `/proc/self/cgroup` was read with `printf` and namespace links with `ls -l`,
   against the "use `read` for text files" rule. Reason: both describe *the bash process
   itself*; a file tool cannot read another process's `/proc/self`. No production config
   was traversed.
3. `/proc/net/unix` was consulted via a file-tool match; it was not in the enumerated list
   of files but is a read-only kernel interface judged necessary to distinguish "socket file
   present but unreachable" from "no listener at all". Its namespace caveat is §5d.
4. No retry, no `systemd-run`, no `node`, no build/install, no service contact, no
   permission change, no `/root/.dsh` access, no environment values printed.

## 8. Minimum follow-up needed (each requires new authorisation)

1. **Decide the execution context.** A `systemd-run` envelope can only be validated from a
   context where the system bus is reachable *and* where the unit's own cgroup is visible —
   in practice, a context whose PID 1 is the systemd that owns the bus. If the harness
   cannot provide that, the honest options are: run the batch from a host shell by a human
   operator, or declare the systemd-envelope requirement unsatisfiable in this environment
   and record that as the constraint.
2. **One discriminating check, if desired** (still read-only, still not a test): compare the
   inode of `/run/systemd/private` *as seen inside the sandbox* against the inode listed for
   that path in the same-namespace `/proc/net/unix`, and capture the `errno` of a raw
   `connect(2)` to it. That separates "different mount instance" from "peer-credential
   rejection". It does not require touching any service.
3. **Do not pre-fill anything** in the batch record meanwhile; it stays REFUSED with no TAP
   figure, no gate sample, no envelope readback and no input hash.

## 9. Freeze

- Files untouched by this investigation: `run.sh`, `payload.sh`, `converter.mjs`,
  `converter.test.mjs`, and the batch record's observed/unobserved values.
- No further execution has been performed beyond the single authorised bash invocation and
  the two file-tool reads above. Anything further waits for explicit authorisation.
