---
title: "How I Deployed This Site"
date: 2026-05-06
tags:
  - hexo
  - nginx
  - devops
  - meta
categories:
  - notes
---

This is the very first real post on the site, and it felt only fitting to write
about how the site itself was put together. Nothing here is novel — it is the
boring, classic recipe — but writing it down forces me to be honest about every
choice I made.

<!-- more -->

## Goals

Before picking any tool, I wrote down what I actually wanted:

1. **A blog.** A place to dump notes I would otherwise forget.
2. **An About page.** A simple introduction so people landing on the site
   immediately know who they are reading.
3. **Cheap and boring infrastructure.** No Kubernetes, no SaaS lock-in, no
   "serverless cold start" surprises. I already have a small Azure VM running;
   it should be more than enough.
4. **Everything in Git.** If I lose the VM tomorrow, I want to recover the site
   in minutes from a fresh box.

That is it. No comments engine, no analytics, no fancy CMS, no SSR — at least
not yet.

## Stack

After comparing Hexo, Hugo, Astro and WordPress, I went with **Hexo**:

- Pure static output — nothing to keep alive, nothing to patch on Tuesday.
- I already write JavaScript / TypeScript every day, so the Node ecosystem is
  comfortable.
- Big Chinese community, plenty of themes, and the default `landscape` theme is
  good enough to start.

The full picture:

| Layer        | Choice                                  |
| ------------ | --------------------------------------- |
| Content      | Markdown under `source/_posts/`         |
| Generator    | Hexo (Node.js)                          |
| Node version | nvm, pinned to current LTS              |
| Web server   | Nginx, serving the generated `public/`  |
| Host         | Azure VM, Debian 12                     |
| Source       | Git, pushed to GitHub                   |

## Walkthrough

The whole bring-up fits on one screen.

### 1. Node, the right way

Distro-packaged Node tends to lag behind. I removed it and installed
[`nvm`](https://github.com/nvm-sh/nvm) instead, then pinned the LTS:

```bash
sudo apt-get remove -y nodejs npm
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install --lts
nvm alias default 'lts/*'
```

`nvm` keeps Node out of system paths and lets me jump versions per-project later
without sudo.

### 2. Hexo skeleton

```bash
mkdir -p ~/src && cd ~/src
npm install -g hexo-cli
hexo init personal-site
cd personal-site && npm install
```

A few edits in `_config.yml` set the title, author and the public URL. Then a
quick scaffold for the About page and the first post:

```bash
npx hexo new page about
npx hexo new post "hello-world"
```

### 3. Static output, served by Nginx

Nothing exotic here. One server block pointing at `public/`:

```nginx
server {
    listen 80 default_server;
    server_name _;

    root /home/liharr/src/personal-site/public;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

Two things bit me on the way:

- **Home directory permissions.** `www-data` could not even traverse into my
  home folder. `chmod o+x /home/liharr` fixed it. I prefer this over moving the
  site to `/var/www/` because I want to edit files as my own user.
- **Cloud firewall ≠ host firewall.** The VM had no `iptables` rules, but the
  Azure NSG was still blocking port 80. The site only became reachable after I
  added an inbound rule in the Azure portal.

### 4. Git from day one

`public/` is generated output, so it lives in `.gitignore`. Everything else
goes in:

```bash
git init -b main
git add . && git commit -m "init: hexo personal site"
gh repo create personal-site --public --source=. --push
```

Now the site is reproducible from [`WhatsFish/personal-site`](https://github.com/WhatsFish/personal-site).

## Design Notes

A few small decisions that I want to remember.

**Source code lives under `~/src/`, not `/var/www/`.**
The site is not a system service in spirit — it is *my* code. Treating it like
a regular project (in `~/src/`, owned by my user, version-controlled) makes
editing and recovery feel natural. Nginx is just the dumb pipe that serves the
build output.

**English filenames and content, even though I read Chinese.**
URLs are forever. ASCII paths are easier to share, easier to grep, and they do
not break when copy-pasted into terminals or chat apps.

**Build is a manual step, on purpose.**
`hexo generate` runs only when I want it to. It would be easy to add a
`post-receive` hook or a GitHub Action that auto-deploys on push, but right now
"think, then publish" is the workflow I want. I will automate later, once
posting friction actually starts to annoy me.

**No comments, no analytics — yet.**
Both are easy to bolt on (Giscus for comments, a tiny self-hosted analytics
script for stats). I would rather start with zero moving parts and add things
when I have a real reason.

## What's Next

In rough order of how much I want them:

- **Real domain + HTTPS.** Cloudflare-registered domain, A record to the VM,
  Let's Encrypt via `certbot --nginx`. Bonus: Cloudflare also hides the origin
  IP.
- **Auto-deploy on push.** A small `post-receive` hook on a bare repo on the VM,
  or a GitHub Action that SSHes in and runs `git pull && hexo g`. The latter
  scales better if I ever write from another machine.
- **A nicer theme.** `landscape` is fine for v1 but I will probably move to
  something like NeXT or Stellar once I have more than three posts.
- **Comments via Giscus.** Free, backed by GitHub Discussions, no database to
  babysit.
- **More writing.** The hardest part is not the infrastructure — it is having
  something to say. This post counts as one.

If you spot something I should have done differently, the source is [right
here](https://github.com/WhatsFish/personal-site) — issues and PRs welcome.
