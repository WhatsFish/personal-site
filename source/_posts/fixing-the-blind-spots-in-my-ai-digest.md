---
title: "Fixing the Blind Spots in My AI Digest"
date: 2026-05-09
tags:
  - ai-feed
  - rss
  - rsshub
  - agent
  - claude-code
categories:
  - notes
---

After about a week of reading [my own AI digest](/feed) every morning, two things were obviously wrong with it. There was no Microsoft. There was no "AI-native work" angle — Mollick, GitHub Copilot announcements, the whole practitioner discourse — just absent. The first few days I assumed I was misremembering. Then I counted, across four days × roughly fourteen developments per day, the number tagged `vendor:microsoft`: zero. The number that talked about how AI changes how teams work: also zero.

<!-- more -->

The digest is built by a headless Claude agent that reads a daily aggregation of RSS feeds and writes an opinionated synthesis. The agent's editorial taste was fine. The problem was upstream: the raw input it was reading didn't *contain* what was missing.

## The first pass: just add sources

The Microsoft hole had a simple shape. I had `Microsoft Research` as a source, but their feed is mostly narrow academic ML papers and very often empty. The product/agent/Foundry/Copilot story comes from elsewhere. So I added two new feeds in the Microsoft ecosystem:

- **GitHub Blog** — Copilot, agent PRs, agentic workflows. ([sample headline](https://github.blog/ai-and-ml/generative-ai/agent-pull-requests-are-everywhere-heres-how-to-review-them/) from this week: "Agent pull requests are everywhere. Here's how to review them.")
- **Microsoft Foundry** — the same product surface my own `/api/interpret` button runs against.

For the practitioner angle, two more:

- **One Useful Thing (Ethan Mollick)** — the gold-standard niche for *AI changes how knowledge workers work.*
- **Pragmatic Engineer (Gergely Orosz)** — same thing for software engineers specifically.

Then in a third pass: **NVIDIA Developer** for the hardware/inference layer, **AlignmentForum** (curated view) for safety/interp theory, and **METR** for empirical capability evals.

## The Anthropic-shaped hole

The most consequential lab in AI right now is Anthropic, and Anthropic publishes **no public RSS** for any of their surfaces. Not for Research, not for Engineering, not for the Frontier Red Team. My digest had been picking up Anthropic news second-hand — Simon Willison's linkblog and Smol AI News both cover it — but the texture was missing. When the actual interpretability paper came out, I'd see "Smol AI noticed Anthropic released X" rather than the source.

The community has built [RSSHub](https://github.com/DIYgod/RSSHub), an open-source service that scrapes RSS-less sites into syndication feeds. It has community-maintained routes for `/anthropic/research`, `/anthropic/engineering`, `/anthropic/red`, and many more. Public RSSHub instances are mostly dead or Cloudflare-blocked from server-side fetches now, so I added a self-hosted one to my docker-compose:

```yaml
rsshub:
  image: diygod/rsshub:latest
  restart: unless-stopped
  environment:
    NODE_ENV: production
    CACHE_EXPIRE: "86400"
  ports:
    - "127.0.0.1:3007:1200"
```

24-hour cache because my fetcher only runs every 12 hours; we want every fetch to hit warm cache. One Anthropic Research route takes ~100s to populate cold (RSSHub fetches each paper page individually), so I added a one-line cron job at `xx:08` to pre-warm before the agent fires at `xx:13`.

The same RSSHub trick also fixes OpenAI's official RSS, which gives ~150-character teasers; routing through `/openai/news` instead returns ~8KB of full article body per item.

## The thin-tail problem

After all that I had 18 sources. I asked, with reasonable confidence, whether the agent now had enough information from each. Then I actually measured.

| Class | Sources |
|---|---|
| Rich body in RSS (1500+ chars) | Anthropic ×3, OpenAI (via RSSHub), METR, AlignmentForum, Smol AI |
| Adequate (500–1500) | Simon Willison |
| Just lede (200–500) | MS Research, GitHub Blog, Foundry |
| **Title + phrase only (<200)** | DeepMind, Mollick, Interconnects, Latent Space, Ahead of AI, Pragmatic, NVIDIA, HN |

Roughly half the sources were giving the agent only a title and a teaser sentence. Substack does this on purpose — even for free posts, the RSS only contains a teaser to push readers to their site. RSS publishers like DeepMind and NVIDIA do similar. RSSHub doesn't help here because their Substack route is a passthrough, not a scraper.

There were two compounding bugs underneath the structural problem. First, my fetcher was truncating every item's body to 280 characters before writing it to the daily aggregation file — a leftover from when there were six sources and the file needed to stay small. Second, METR (and a handful of other WordPress feeds) put their actual content in `<content:encoded>` while my parser only read `<description>`, so METR was contributing literally zero characters of body. Easy fixes: bump the truncation cap to 1500 and prefer `encoded` over `description` when both exist. METR went from 0 to ~12,000 characters per item.

But the structural problem — Substack and DeepMind only ever emitting teasers — needed something different. The headless agent that produces the digest is a [Claude Code](https://claude.com/claude-code) instance with WebFetch as a tool. So I added one paragraph to the agent's task prompt:

> **Deep-fetch the thin tail.** For items whose excerpt looks too thin *and* whose title suggests it could be one of today's developments, use WebFetch on the item's link to pull the full article and synthesize from that. Budget ~10 fetches per run. Failures (paywall, 403, timeout) fall back silently to the RSS excerpt.

Before doing this I tested feasibility by curl-fetching one URL per thin source and counting the words I could extract: 5 of 7 returned full clean article text (Mollick, Interconnects, Latent Space, DeepMind, NVIDIA), 2 had paywalls but their public preview was still 5–10× richer than the RSS teaser.

The first run after deploying it: the agent fetched 5 URLs without me asking which. Two were Anthropic Research articles where it wanted more depth than the truncated RSS gave it; one was a HuggingFace paper page; one was a third-party news site that an HN item linked through to (the agent picked the more authoritative source on its own); one was the *Anthropic Institute* announcement. The takes started showing up with specific numbers — "22% → 3% misalignment with 28× fewer tokens" — instead of vibes.

## End state

Twenty sources now, four layers of filter, one self-hosted bridge container. The blind spots from a week ago are closed:

- `vendor:microsoft` and `vendor:apple` show up in the tag set
- Engineering practice from Anthropic, GitHub, and Mollick is first-class
- Interpretability and alignment research has dedicated representation (METR, AlignmentForum, Anthropic Research)
- The agent fills in gaps that RSS truncation introduces by reading the actual articles

The piece I'm most pleased with is the last one — the agent deciding which articles to deep-read. I gave it a budget and a heuristic and it figured out, on its own, that an HN link to a third-party DeepSeek article was a better source than the HN comment thread itself. That's the kind of judgment call you can't bake into a fetcher; it has to live in whatever's actually reading the feed. Which is, I guess, increasingly the point.

The code for all of this is at [github.com/WhatsFish/ai-feed](https://github.com/WhatsFish/ai-feed). The output is at [ai-native.japaneast.cloudapp.azure.com/feed](https://ai-native.japaneast.cloudapp.azure.com/feed) — published twice a day, English and 中文, no signup.
