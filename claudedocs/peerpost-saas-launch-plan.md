# PeerPost — SaaS Launch Plan v2 (finance proposal)

*2026-06-28. Competitor prices = public 2026 pages (monthly billing, base + next-to-base tier, free tier excluded). "My cost" = modelled COGS to deliver the **same allowance**. Two cost lines shown: **Managed** (PeerPost pays the APIs) and **BYOK** (user brings keys → API ≈ $0). Publishing via **PostPeer** (not Zernio). Figures are planning estimates with assumptions stated.*

**Cost basis used throughout:** Deepgram $0.0043/src-min · Gemini selection ~$0.02/video · Gemini translate ~$0.01/lang/video · **TTS = $0 (edge_tts)** · PostPeer $0.0085/post (unlimited accounts) · YouTube download via Apify ~$0.30/video (Drive/upload = $0). Blended source video ≈ 20 min.

---

## 1. Per-category: competitor base + next tier vs MY cost to deliver the same

### 🎬 Clipping — vs Opus Clip
| | Opus price | Allowance | **My COGS — Managed** | **My COGS — BYOK** |
|---|---|---|---|---|
| Base (Starter) | **$15/mo** | 150 source-min | **~$0.85** | ~$0 |
| Next (Pro) | **$29/mo** | 300 source-min | **~$1.70** | ~$0 |

### 🌐 Dubbing — vs HeyGen
| | HeyGen price | Allowance | **My COGS — Managed** | **My COGS — BYOK** |
|---|---|---|---|---|
| Base (Creator) | **$29/mo** | 200 cr ≈ 100 dub-min | **~$0.50** | ~$0 |
| Next (Pro) | **$49/mo** | 2,000 cr ≈ 1,000 dub-min | **~$5.00** | ~$0 |

> Dubbing is the standout: TTS is free, so 1,000 minutes of dubbing costs me ~$5 vs HeyGen's $49. A 20-min video into **all 15 languages ≈ $0.25**.

### 📤 Publishing — vs Buffer (budget) & Sprout (premium)
| | Their price | Allowance | **My COGS via PostPeer** |
|---|---|---|---|
| Buffer Essentials | **$6/channel** (5 ch = $30) | scheduling, 5 channels | **~$4.25** for 500 posts, **unlimited** accounts |
| Buffer Team | **$12/channel** (5 ch = $60) | + team | same |
| Sprout Standard | **$199/seat** | 5 profiles, inbox, analytics | **~$4–17** total (shared), unlimited accounts |
| Sprout Professional | **$299/seat** | unlimited profiles | same |

> PostPeer charges **$0.0085/post with unlimited connected accounts** — so I deliver Sprout-class publishing for **single-digit dollars**, not $199/seat. (Sprout also bundles social-inbox/listening we don't — we compete on publish+schedule, like Buffer.)

### The headline
**A creator buying the *next* tier of each = Opus $29 + HeyGen $49 + Buffer ~$30–60 = ~$108–138/mo** (or **+$299 if they want Sprout**). **My cost to deliver all of it: ~$7 managed / ~$0 BYOK** (+ server share). That gap is the entire business case.

---

## 2. Server cost → how many users (separate calc)

Per-job ≈ 4 min wall-clock with NVENC. "Comfortable active users" already discounts for peak-hour clustering (people aren't all processing at once).

| Server | Cost/mo | Concurrent jobs | Throughput ceiling | **Comfortable active users** | ≈ Registered base |
|---|---|---|---|---|---|
| **GEX44** (RTX 4000 Ada) | **~$300** | 10–18 | ~700–900 jobs/day | **150–300** | ~400–700 |
| **GEX131** (RTX PRO 6000) | **~$1,600** | 30–45 | ~2,500–3,500 jobs/day | **500–1,000** | ~1,500–2,500 |

*Assumes NVENC enabled + the queue/worker hardening from ADR-0001. On today's CPU-encode setup, halve these. Throughput ceiling is higher than "comfortable" if usage is well-spread across the day.*

---

## 3. My plans & features (all-in-one bundle, priced below competitors)

Each plan bundles **clipping + dubbing + publishing**. Two prices per tier: **BYOK** (you bring keys, cheaper) and **Managed** (we cover APIs). Benchmarked to undercut the competitor bundle.

| Plan | BYOK / Managed | Clipping | Dubbing | Publishing | Accounts | Extras | Competitor equiv. |
|---|---|---|---|---|---|---|---|
| **Free** | $0 | 30 min | 30 min | 100 posts | 2 | watermark | trials |
| **Creator** | **$19 / $29** | 150 min | 150 min | 1,000 posts | 5 | no watermark | Opus$15 + HeyGen$29 = **$44** |
| **Pro** | **$49 / $69** | 300 min | 600 min | 5,000 posts | 25 | all langs, 1080p, priority | $108–138 elsewhere |
| **Agency** | **$129 / $179** | 1,200 min | 2,000 min | unlimited | 100 | team seats, white-label, API | Sprout/Hootsuite alone |

**Pricing logic:** every tier is **~30–60% cheaper than buying the equivalent competitor tiers separately**, which is the acquisition wedge. BYOK saves the user ~30% and costs you almost nothing to serve.

### Per-plan gross margin (managed)
| Plan | Price (managed) | Est. COGS (API + PostPeer + server share) | Gross margin |
|---|---|---|---|
| Creator $29 | $29 | ~$4–6 | **~80%** |
| Pro $69 | $69 | ~$10–15 | **~80%** |
| Agency $179 | $179 | ~$30–45 | **~78%** |
| (any tier, BYOK) | −$ | ~$3–5 (server + PostPeer only) | **~85–90%** |

---

## 4. Income per server (illustrative)

Blended ARPU assumes a Creator-heavy mix with some Pro/Agency.

### On one GEX44 (~$300/mo)
| Active paying users | Blended ARPU | **MRR** | COGS (server + API + PostPeer) | **Gross profit** | Margin |
|---|---|---|---|---|---|
| 100 | $40 | $4,000 | $300 + ~$800 + ~$150 = ~$1,250 | **~$2,750** | 69% |
| 250 | $42 | $10,500 | $300 + ~$2,000 + ~$350 = ~$2,650 | **~$7,850** | 75% |

### On one GEX131 (~$1,600/mo)
| Active paying users | Blended ARPU | **MRR** | COGS | **Gross profit** | Margin |
|---|---|---|---|---|---|
| 500 | $45 | $22,500 | $1,600 + ~$4,000 + ~$700 = ~$6,300 | **~$16,200** | 72% |
| 1,000 | $48 | $48,000 | $1,600 + ~$8,000 + ~$1,400 = ~$11,000 | **~$37,000** | 77% |

**Break-even ≈ 25–40 paying users** on a single GEX44. BYOK-heavy mixes push margins to ~85%+.

*Excludes one-off engineering, support, payment processing (~3%), and marketing/CAC — model those against gross profit.*

---

## 5. Recommendation
1. **Launch on one GEX44 ($300/mo)** — serves 150–300 active users; break-even ~25–40 paying.
2. **Plans:** Creator $19/$29 · Pro $49/$69 · Agency $129/$179, **BYOK + Managed** toggle.
3. **Publishing on PostPeer** ($17–43/mo plans, $0.0085/post, unlimited accounts) — far cheaper and simpler than Zernio/Sprout, and you already integrate it.
4. **Fund ~4–6 weeks productization** (queue + NVENC + billing + multi-tenancy; ADR-0001) before public launch.
5. **Scale to GEX131** past ~250 active users; add nodes per ~600–1,000 users. Target **~75–80% gross margin**.

### Risks (unchanged): free `edge_tts` is unofficial (budget paid fallback), YouTube-download ToS, PostPeer/platform rate caps, API price drift. All mitigable; none break the model.

---

## 6. Worked scenario: 500 paid users · GEX44 · BYOK · PostPeer

With **BYOK, your API cost is ~$0** (users pay Deepgram/Gemini). Your **only variable cost is PostPeer**, driven by:

> **PostPeer cost ≈ users × (pieces/mo) × (platforms per piece) × $0.0085/post**

A PostPeer "post" = **one publish to one account** (a reel to 5 platforms = 5 posts).

### General posting cadence (2026 benchmarks → posts/mo)
| User type | Pieces/mo | Platforms/piece | **Posts/mo** |
|---|---|---|---|
| Light creator | ~15 | 4 | ~60 |
| Medium creator | ~30 | 5 | ~150 |
| Heavy / agency / multi-language | ~50–60 | 8–10 | ~450–600 |

Blended average ≈ **150–200 posts/user/mo**.

### PostPeer cost for 500 users
| Skew | Avg posts/user | Total posts/mo | **PostPeer/mo** |
|---|---|---|---|
| Light | 100 | 50,000 | ~$250–425 |
| **Realistic** | **170** | **85,000** | **~$425–720** |
| Heavy | 300 | 150,000 | ~$750–1,275 |

### Total COGS (500 BYOK users, GEX44)
| Line | $/mo |
|---|---|
| GEX44 server | $300 |
| Gemini + Deepgram (BYOK) | **$0** |
| PostPeer (realistic) | ~$500–700 |
| **Total** | **~$800–1,000** (~$1.60–2.00/user) |

### BYOK plans with **post caps** (the cost guardrail)
| Plan | Price (BYOK) | Posts/mo | Accounts | Clip/Dub min | PostPeer at cap |
|---|---|---|---|---|---|
| Creator | $15 | 500 | 5 | 120 / 120 | ≤ $4.25 |
| Pro | $39 | 2,500 | 25 | 300 / 600 | ≤ $21 |
| Agency | $99 | 10,000 | 100 | 1,200 / 2,000 | ≤ $85 |

Most users sit well below cap (~60–200 posts) → actual PostPeer ≈ $0.50–1.70/user; caps only protect against outliers.

### 500-user P&L (BYOK, mix 60% Creator / 30% Pro / 10% Agency)
- **Revenue:** 300×$15 + 150×$39 + 50×$99 = **~$15,300 MRR**
- **COGS:** $300 + $0 + ~$700 = **~$1,000**
- **Gross profit: ~$14,300/mo (~93% margin)**

### ⚠️ Capacity caveat
GEX44 comfortably serves **~150–300 *active* users**. 500 *paid* is fine **if not all are heavy daily video-generators** (publishing is light on the GPU; **video generation** is the load). As genuine active users approach ~300, add a 2nd GEX44 or move to GEX131. **This is the constraint the scalability work (this branch) removes** — by making the worker pool horizontally scalable.

### Sources
Opus Clip, HeyGen, Sprout Social, Buffer, Hootsuite, PostPeer, Deepgram, Gemini, Apify — 2026 pricing pages (links in chat).
