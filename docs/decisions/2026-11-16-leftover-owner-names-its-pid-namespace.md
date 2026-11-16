# A leftover's owner names its pid namespace

Amends: [The record store sweeps what a killed call left, once its maker is gone](2026-11-16-record-store-sweeps-what-a-killed-call-left.md), the owner key and its limit

Status: for [issue #520](https://github.com/melian-agent/melian/issues/520), which the maintainer marked P0 on 2026-11-16, in the coordinator's session. The method is the one the issue sets out.

## Problem

The sweep's owner key hashed the host's name alone. A process table lists the processes of one pid namespace, so two containers in one pod could share a host name and a mounted state directory while each kept its own pids. Container A runs a call as pid 37. Container B opens the store, finds no pid 37 in its own table, reads A's leftover as its own host's, and deletes A's live index or half-made repository. Nothing reports it. The design lens raised it on [pull request #519](https://github.com/melian-agent/melian/pull/519). The maintainer ruled on 2026-11-16, in the coordinator's session, to dismiss it there against the recorded limit and fix it here.

## Choice

On Linux the key hashes the host's name with the device and inode of `/proc/self/ns/pid`, which name this process's pid namespace. The name's format is unchanged. A container that shares the host's pid namespace reads the host's device and inode, which is right, since its table lists the host's processes. When Linux will not answer that read, a call names what it makes by a UUID alone, and the sweep keeps every owned leftover, since no name matches this host. macOS has no pid namespaces, so there the host's name alone stays the key, and the sweep still removes what an exited call left.

## Why

A pid means something only inside the namespace whose table is read. The device and inode are what the kernel gives to tell one namespace from another, and reading them costs one `stat`. A failed read gives a key the sweep can never match, so a mistake costs disk, never a live call's index.

One limit stays. Every Linux kernel gives its first pid namespace the same inode, so two separate machines with one host name and a shared state directory still read as one. Melian does not support sharing a state directory across hosts.

Leftovers that an earlier build named on Linux, after the host's name alone, no longer match this host and are kept and named by `melian doctor`. That build was on `main` only from [pull request #519](https://github.com/melian-agent/melian/pull/519)'s merge until this change, so few exist, and a person removes any by hand.
