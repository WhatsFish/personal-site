---
title: "What's Running on This Server"
date: 2026-05-06
updated: 2026-05-07
tags:
  - nginx
  - docker
  - infrastructure
  - meta
  - https
  - agent
categories:
  - notes
---

A map of every public-facing system on `ai-native.japaneast.cloudapp.azure.com`,
why each one exists, and how they're wired together. Updated 2026-05-07 after
HTTPS, an AI-feed portal, a service catalog at `/`, and a couple of small
relocations.

<!-- more -->

## The fleet

Seven things share a single Azure VM (Japan East, B2s) behind one Nginx
HTTPS server block:

| URL | What it is | Stack |
|---|---|---|
| [/](https://ai-native.japaneast.cloudapp.azure.com/) | Service catalog | Static HTML, served by Nginx |
| [/myblog](https://ai-native.japaneast.cloudapp.azure.com/myblog) | This blog | Hexo (static) |
| [/feed](https://ai-native.japaneast.cloudapp.azure.com/feed) | Daily AI-frontier digest | Next.js + a headless Claude Code agent on cron |
| [/chat](https://ai-native.japaneast.cloudapp.azure.com/chat) | Personal AI chat | Next.js + Postgres + Azure AI Foundry (managed identity) |
| [/vpn](https://ai-native.japaneast.cloudapp.azure.com/vpn) | Hysteria2 VPN dashboard | Next.js + Postgres + host-side collector |
| [/traffic](https://ai-native.japaneast.cloudapp.azure.com/traffic/) | Web access-log report | GoAccess static HTML (5-min cron) |
| [/umami](https://ai-native.japaneast.cloudapp.azure.com/umami) | Pageview analytics | Self-hosted Umami v2 (rebuilt from source) |

Everything is path-routed under one HTTPS hostname, so the public surface
stays small: TCP/80 (auto-redirected to 443), TCP/443 for the web stack,
and UDP/443 for the VPN itself. Let's Encrypt issues the cert; certbot's
systemd timer renews on its own.

## How routing works

One Nginx server block, with per-app snippets included from each repo:

```nginx
server {
    listen 443 ssl;
    server_name ai-native.japaneast.cloudapp.azure.com;

    ssl_certificate     /etc/letsencrypt/live/.../fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/.../privkey.pem;

    include snippets/traffic-monitor.conf;   # /traffic + /umami
    include snippets/ai-playground.conf;     # /chat
    include snippets/vpn-monitor.conf;       # /vpn
    include snippets/ai-feed.conf;           # /feed

    # Catalog at root.
    location = / {
        root /home/liharr/src/site-index;
        try_files /index.html =404;
    }

    # Hexo, regenerated with `root: /myblog/`.
    location /myblog/ {
        alias /home/liharr/src/personal-site/public/;
        try_files $uri $uri/index.html =404;
    }

    # Anything else falls through to a hard 404 — no catch-all that
    # might leak the filesystem.
    location / { return 404; }
}
```

Each `snippets/*.conf` is a **symlink into the matching git repo**, so
routing config travels with the application. Adding a new portal is a
five-step ritual:

1. Write `nginx/<name>.conf` in the new repo (`location /<name> { proxy_pass ... }`).
2. Bind the container to a free `127.0.0.1:<port>`.
3. Symlink it into `/etc/nginx/snippets/`.
4. Add one `include` line to the personal-site server block.
5. `sudo nginx -t && sudo systemctl reload nginx`.

## Each piece, briefly

### Catalog (`/`)

A single static `index.html` (no JS, no framework, ~5 KB) that lists the
seven URLs above with a one-line description and an auth tag where
relevant. Light/dark mode via `prefers-color-scheme`. Nginx serves it
straight off the disk; nothing to deploy or build.

### Blog (Hexo, `/myblog/`)

Plain static files. Builds locally with `hexo generate`. Moved from `/`
to `/myblog/` so the catalog could take the root. The move was a config
flip: `root: /myblog/` in `_config.yml`, then a regenerate so all internal
links acquired the new prefix.

### ai-feed (`/feed`)

The newest piece, and the one with the most architectural decisions packed
into a small space. It's a **daily digest of frontier-AI news, synthesized
by a Claude Code agent**. Three layers:

1. **Fetcher** — a pure-stdlib Python script. Twice a day, cron pulls a
   curated list of RSS/Atom feeds plus the HuggingFace daily-papers JSON
   API, dedupes against `seen.json`, and appends new items to a daily
   markdown file. ~300 lines, no dependencies.
2. **Agent** — system cron also fires `claude -p` (headless Claude Code)
   with a fixed prompt task. The agent reads the day's raw items, decides
   what matters, and writes three outputs: human-readable markdown,
   strict-schema JSON, and a Chinese translation. The agent re-synthesizes
   prose on every run, so reruns within the same time slot collapse to a
   single well-written entry rather than stacking meta-commentary on top
   of itself.
3. **Portal** — a Next.js 14 reader. Reads the JSON files directly off
   disk; no DB. Public by default — anyone can read the digest and switch
   between English and 中文 without signing in. Only the live "AI explain"
   button per item requires GitHub OAuth, because that one calls Azure AI
   Foundry per click and I'd rather rate-limit by login than by IP.

The interesting design choice is the data contract. The agent and the
portal couple via a frozen JSON schema (`developments[].id` is a stable
slug for deep links, `tags` use a controlled vocabulary like
`vendor:openai` / `compute` / `agent`). Both sides validate with the same
zod schema. Adding a field is a two-sided change.

A 90-day retention cron keeps the disk bounded; logs get tail-truncated
when they pass 5 MiB.

### ai-playground (`/chat`)

A small Next.js 14 app to talk to Azure-hosted models without API keys
in plaintext. Auth is GitHub OAuth, gated by an allowlist. Like ai-feed,
the auth route handler re-prepends the `/chat` basePath to inbound URLs
because Next.js strips it before invoking handlers — Auth.js then matches
its configured basePath at both ends (action parsing *and* OAuth callback).

The Azure side is the more interesting bit. Instead of long-lived API
keys, the VM has a system-assigned **managed identity** with the
`Cognitive Services User` role on the AI resource. The app calls
`DefaultAzureCredential` → hits the IMDS endpoint → gets a short-lived
bearer token → calls
`https://<resource>/openai/v1/chat/completions` with `stream: true`.
Token refresh is cached in-process. **No secrets in env files, no
rotation.** ai-feed's interpret endpoint reuses the exact same token
helper.

### vpn-monitor (`/vpn`)

A dashboard for the Hysteria2 VPN that already runs on the same host.
Two moving parts:

1. **Collector** — a tiny systemd service on the host. Polls Hysteria's
   `trafficStats` HTTP API every 30s for cumulative byte counts and
   active connection counts, and tails `journalctl -fu hysteria-server`
   for `client connected` / `client disconnected` / `authentication
   failed` events. Source IPs go through `ip-api.com` for country/region/
   ISP, with a Postgres cache to stay under the free tier's rate limit.
2. **Web** — same Next.js + Auth.js skeleton as ai-playground, just
   pointed at the collector's tables. Two pages: an Overview (cumulative
   tx/rx, current throughput, 24h connect/disconnect/auth-failed counts)
   and a Connections table.

The collector lives on the host (not in a container) because reading
journald from inside Docker is annoying — needs the right machine-id,
the journal directory mounted, and `journalctl` available. A 30-line
systemd unit is just simpler.

### GoAccess (`/traffic/`)

Server-side log analyzer. A cron job runs every 5 minutes, reads
`/var/log/nginx/personal-site.access.log`, and writes a static HTML
report into a directory Nginx aliases at `/traffic/`. Zero JS, zero
database, just fast facts about what hit the box.

### Umami (`/umami`)

A self-hosted, privacy-friendly Google-Analytics-alternative. The
prebuilt `postgresql-latest` image bakes its `basePath` at build time
with no prefix, so all internal asset paths (`/_next/*`, `/api/*`)
resolve at root. That made it impossible to subroute under `/umami` on
the same domain — the proxy worked, but every client-side asset request
404'd.

The fix was to **build Umami from upstream source with
`BASE_PATH=/umami` baked in**. The compose file changed from
`image: ghcr.io/umami-software/umami:postgresql-latest` to a `build:`
block pointing at the GitHub repo with the basePath as a build arg.
After that, Nginx fronts it at `/umami` with a small but important
caveat: the `location` directive uses no trailing slash (`location /umami`
not `location /umami/`) because Nginx auto-redirects `/umami` → `/umami/`,
and Umami itself sends the opposite redirect (`/umami/` → `/umami`),
which loops. Dropping the trailing slash from the location stops Nginx
from interfering.

## Shared Postgres

Three database-backed services (Umami, ai-playground, vpn-monitor) talk
to the **same Postgres container** spun up by the `traffic-monitor`
repo. They each get their own database and role. The container is bound
to `127.0.0.1:5432` so host-side services (the vpn-monitor collector)
can reach it, but it's invisible from the public internet.

ai-feed deliberately doesn't join. Its data is a few markdown and JSON
files per day; treating that as filesystem rather than rows kept it
clone-and-go simple, no schema migration coupling.

## Port allocation

| Port | Where |
|---|---|
| 80 / TCP | Nginx — auto-redirect to 443 |
| 443 / TCP | Nginx HTTPS entrypoint |
| 443 / UDP | Hysteria2 VPN |
| 3000 / TCP | Umami (loopback only, fronted by Nginx at `/umami`) |
| 3001 / TCP | ai-playground web (loopback) |
| 3002 / TCP | vpn-monitor web (loopback) |
| 3003 / TCP | ai-feed web (loopback) |
| 5432 / TCP | Postgres (loopback) |
| 7653 / TCP | Hysteria trafficStats (loopback) |

Everything user-facing now terminates TLS at Nginx; backend services
only listen on `127.0.0.1`. The Azure NSG only needs to permit 22 (SSH),
80, 443/TCP, and 443/UDP.

## What I'd add next

Older entries from the previous version of this post:

- ~~HTTPS~~ — done. Let's Encrypt via certbot's `--nginx` plugin, on
  the Azure-issued FQDN. Auto-renews via `certbot.timer`.
- ~~A landing page at `/`~~ — done; that's the catalog above.

Still on the list:

- **vpn-monitor v2**: per-user accounting (requires migrating Hysteria
  from single-password to multi-user auth), historical throughput
  charts, and a real map for the Connections page.
- **ai-feed cross-day memory**: the agent currently sees only today's
  feeds. Passing the last N days' digests in the prompt would let it
  spot week-over-week patterns ("this is the third VLA paper this
  week"). Costs more tokens — wait until the value is obvious.
- **Custom Umami events**: pageviews are auto-captured, but
  `umami.track('lang-toggle')` and `umami.track('outbound', {url})`
  would surface real engagement on ai-feed. Add when the pageview
  data points at something worth instrumenting.
- **Health endpoint** for ai-feed (`/api/health` returning
  `{latest_digest_age_hours, failed_sources, ...}`) so an external
  prober can alert when the agent stalls.

The repos:

- [personal-site](https://github.com/WhatsFish/personal-site)
- [traffic-monitor](https://github.com/WhatsFish/traffic-monitor)
- [ai-playground](https://github.com/WhatsFish/ai-playground)
- [vpn-monitor](https://github.com/WhatsFish/vpn-monitor)
- [ai-feed](https://github.com/WhatsFish/ai-feed)
