---
title: "Adding a Data Disk Without Touching Docker"
date: 2026-05-08
tags:
  - docker
  - infrastructure
  - storage
  - debugging
  - observability
categories:
  - notes
---

The root disk on my Azure VM was at 84% (24G of 30G), and I'd been quietly ignoring it for a couple of weeks. Time to fix it. The interesting parts weren't the partitioning — they were figuring out who was actually eating the space, picking a layout that didn't require reconfiguring any daemons, and then discovering a check on the status dashboard that had been "working" by coincidence.

<!-- more -->

## Where the space actually went

First instinct: it's Docker. Six containers run on this box (Next.js apps, a shared Postgres, Umami), so this seemed obvious. `du -sh /var/lib/docker` said 2.9G — nope, not the culprit. Walking up one level:

```
$ sudo du -h -d 1 /var/lib | sort -h | tail -5
140M    /var/lib/apt
22M     /var/lib/dpkg
2.9G    /var/lib/docker
9.5G    /var/lib/containerd
13G     /var/lib
```

`/var/lib/containerd` was 9.5G. That was a small surprise, because Docker uses containerd as its runtime on this Debian 12 install — but image layers and snapshots live in `/var/lib/containerd`, not `/var/lib/docker`, when you're on the modern containerd-backed setup. The `docker info` lookup confirmed it (`Runtimes: io.containerd.runc.v2`). So the real story was 12.4G of container image state, split across two paths I needed to relocate together.

## The plan: bind-mount, not reconfigure

Two options for moving Docker's data:

1. **Reconfigure the daemons**: edit `/etc/docker/daemon.json` to set `"data-root": "/data/docker"`, edit `/etc/containerd/config.toml` to set `root = "/data/containerd"`, restart everything. Daemons now write to the new disk. But the on-disk paths change, and any tool that hardcodes `/var/lib/docker` (logging tools, monitoring containers, manual scripts) needs updating.

2. **Bind-mount**: format the new disk, mount it at `/data`, copy the data over, then `bind`-mount `/data/docker` back to `/var/lib/docker` and `/data/containerd` back to `/var/lib/containerd`. From the daemons' perspective, nothing changed. From the kernel's perspective, those paths now resolve to the new filesystem. Zero config changes.

I went with bind-mount. It's transparent, the rollback is trivial (unmount + restart), and the "physical location moved but logical path didn't" property means any future tool that pokes at `/var/lib/docker` keeps working.

## The execution

Azure attached the new 128G disk as `/dev/sdc`. Single GPT partition, ext4, label `data`:

```bash
sudo /sbin/sgdisk -Z /dev/sdc
sudo /sbin/sgdisk -n 1:0:0 -t 1:8300 /dev/sdc
sudo blockdev --rereadpt /dev/sdc
sudo mkfs.ext4 -F -L data /dev/sdc1
```

(Why `sgdisk` and not `parted`? `parted` wasn't installed and `sgdisk` was already on the box. Same outcome.)

Then a two-pass rsync. The first pass runs while Docker is still up — it copies the bulk of the 12.4G of cold image layers, which don't change. The second pass runs after Docker is stopped and only copies the delta. This minimizes downtime: 30 seconds of stopped containers instead of five minutes.

```bash
# warm copy (services still running)
sudo mount /dev/sdc1 /data
sudo rsync -aHAX /var/lib/docker/      /data/docker/
sudo rsync -aHAX /var/lib/containerd/  /data/containerd/

# downtime window: stop, delta-rsync, swap, bind, restart
sudo systemctl stop docker.socket docker containerd
sudo rsync -aHAX --delete /var/lib/docker/      /data/docker/
sudo rsync -aHAX --delete /var/lib/containerd/  /data/containerd/
sudo mv /var/lib/docker      /var/lib/docker.old
sudo mv /var/lib/containerd  /var/lib/containerd.old
sudo mkdir /var/lib/docker /var/lib/containerd
sudo mount --bind /data/docker      /var/lib/docker
sudo mount --bind /data/containerd  /var/lib/containerd
sudo systemctl start containerd docker
```

The `.old` directories stay around as a rollback button. If anything had gone wrong I could `umount` the bind-mounts and `mv` them back. Three lines of `fstab` made it survive a reboot:

```
UUID=<sdc1-uuid>  /data                 ext4  defaults,nofail  0  2
/data/docker      /var/lib/docker       none  bind,nofail      0  0
/data/containerd  /var/lib/containerd   none  bind,nofail      0  0
```

`nofail` on each line is the boot-safety bet: if `/dev/sdc1` ever fails to come up (disk replaced, UUID typo, whatever), the system still boots without the data disk rather than dropping to emergency mode. The bind-mounts also need `nofail` because they depend on `/data` being there first.

After restart, all eight containers came back, the database came up healthy, and the status dashboard turned green again. Once I'd let things bake for a few minutes, I deleted the `.old` directories. Disk usage:

| | Before | After |
|---|---|---|
| `/` (root, 30G) | 24G / **84%** | 14G / **49%** |
| `/data` (128G) | — | 9.7G / 9% |

## The check that was working by accident

Now the part I didn't see coming. The status dashboard has a host-level `Disk usage (/)` check — it runs in a container, and its implementation is, charmingly:

```ts
const { stdout } = await execAsync("df", ["-P", "/"]);
```

A comment above it cheerfully explains "Disk usage of the container's root mount, which under docker overlay2 reports the host's underlying filesystem." This had been true. After the move, the check started reporting the same number as the new `/data` check — both ~8%, both 125G total.

The reason: when you `df /` from inside a container, you're hitting overlay2. Overlay2's lower directory lives at `/var/lib/docker/overlay2/...`, which used to resolve to the host's root filesystem (sdb1) — so `df /` "happened to" report sdb1's stats. After the bind-mount, `/var/lib/docker` now resolves to sdc1, so `df /` now reports sdc1's stats. The check was right by coincidence, not by design.

The fix is to give the container an explicit, intentional view into each disk:

```yaml
volumes:
  - /boot:/host-root:ro    # /boot lives on sdb1 → /host-root reports the root fs
  - /data:/host-data:ro    # the secondary disk
```

`/boot` is on the root filesystem, contains nothing sensitive (kernel images), and gives `df` a path that resolves to sdb1 from inside the container. Then the disk check refactored into a per-path factory:

```ts
function makeDiskCheck(opts: { id: string; name: string; path: string }): CheckFn {
  return async () => {
    const { stdout } = await execAsync("df", ["-P", opts.path]);
    // ... parse, threshold, return
  };
}

export const diskUsage     = makeDiskCheck({ id: "host-disk",      name: "Disk usage (/)",     path: "/host-root" });
export const dataDiskUsage = makeDiskCheck({ id: "host-disk-data", name: "Disk usage (/data)", path: "/host-data" });
```

Two checks now, each looking at the disk it claims to be looking at. Numbers came out right immediately: `/` at 49% and `/data` at 8%.

## What I'd do differently

The bind-mount approach is the part I'd repeat without hesitation. The daemon-config approach would have been one-line-shorter, but it scatters the change across three files (`daemon.json`, `containerd/config.toml`, `fstab`) and locks every future tool into knowing about it. The bind-mount keeps the lie simple and external: `/var/lib/docker` is still `/var/lib/docker`, it just happens to live elsewhere.

The status check incident is a reminder that monitoring code earns its keep when the assumptions underneath it change. The original check had been correct for as long as I had only one disk. The day the layout shifted, the check shifted with it — silently, in the wrong direction. If I'd put a unit-style assertion in the check ("the filesystem under inspection should have at least X bytes"), I'd have caught it the moment the numbers stopped making sense. Worth thinking about for the next probe I write.

The other thing I added on the way out: a small chip strip across the top of the dashboard that pulls out the metrics I look at most — `/`, `/data`, memory, load, last-success-age for the two Claude agents that run on cron, and the 30-day API spend. The page used to be 38 dotted rows in three columns; now it's 7 colored pills, two featured cards (ai-feed and a virtual "Agents" group that pulls together the freshness checks for both agents and their cost-logging parity), and the rest of the services in the same compact grid as before. Nothing is hidden, but the things that matter most are visible without scanning.

## Layout map

```
/dev/sdb1  30G  root         OS, source code, system config
/dev/sdc1  128G /data        Docker state (bind-mounted into /var/lib/{docker,containerd})
                             plus future bulk per-project data under /data/<project>/
```

The rule going forward: anything Docker-managed automatically lands on `/data` via the bind-mount, no thought required. Bulk non-Docker data (model weights, scrape outputs, dataset caches) goes explicitly under `/data/<project>/`. Source code and config stay on root, where they're small and easy to back up. The 30G boot disk should now last as long as the VM does.
