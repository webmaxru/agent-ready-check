# The AI-Native League

A public, community-submitted leaderboard of the most agent-ready websites, with a game around it. The goal is that fixing a real finding feels like a move in a game: every report shows the fixes worth the most points, every re-scan can pay XP, and the board shows who leads.

Pages: `/league` (boards), `/league/{host}` (profile), `/league/badge/{host}.svg` (rank badge). API: `GET /api/league`, `GET /api/league/{host}`, `POST /api/league`. MCP: read-only `get_league`. Every page also exists as Markdown (`.md` or `Accept: text/markdown`).

## Joining

Anyone can add a public site. This is not site-owner opt-in: nothing verifies that the owner took part or agrees, and the pages say so. Joining requires a report this service stored itself (there is no way to upload or edit a report), no older than 7 days, of the site's home page, for a public domain name (no IP addresses, ports or local names). A scan that redirects to another site is refused. `www.example.com` and `example.com` are one standing. The report page shows a "Join the League" button; `POST /api/league` takes `{"report_id"}` or `{"url"}`. Submitting a newer report updates the standing; resubmitting the same report is a no-op; an older report than the one on the board is refused with 409.

What becomes public: host name, score, level, layer scores, score history (last 30 points), XP, achievements. Nothing else from the report is kept.

## Rules

- **Divisions** by score: Bronze 0-39, Silver 40-69, Gold 70-84, Platinum 85-94, Diamond 95-100 (see `DIVISIONS` in `src/league/engine.mjs`, the source of truth).
- **Boards**: Top (score, then level), Climbers (gain over the last 30 days), Grinders (XP), Fresh (joined in the last 14 days). Equal values share a rank (1, 2, 2, 4).
- **XP**: +100 on joining; +10 per point above your own best score ever; +150 per isitagentready level above your best level ever; a weekly streak bonus of 25 x streak weeks (capped at 10) for re-scanning in consecutive calendar weeks; plus achievement XP. Points you already earned pay nothing, so dropping and re-climbing cannot be farmed.
- **Achievements**: 20, each tied to real checks (for example Bot Whisperer: robots.txt, AI rules, content signals, sitemap). They are listed on `/league#rules` and in `ACHIEVEMENTS`.
- **Layer crowns**: the best score in each layer holds its crown. A layer of the week is spotlighted.
- **Quests**: on a report, failing and warning checks ranked by the score they would add if fixed (same weights as the real score).
- **Dormant and forgotten**: no re-scan for 60 days takes a site off the boards; its entry is deleted after 180 days.

## Storage

One interface (`list`, `get`, `submit(host, fn)`, `remove`) over the same stores as reports:

| Runtime | Where |
| --- | --- |
| memory | process memory (lost on restart) |
| fs | `.league.json` next to the reports |
| Azure Blob | `board.json` in a separate `league` container (the `reports` container expires blobs after 30 days) |
| D1 | `league` table, one row per host, compare-and-swap on a version column |

`submit` is an atomic read-modify-write, so two submissions at once cannot lose each other.

## Integrity

- Every score comes from a scan this service ran. A submission carries only a report id; the stored report is the evidence, and its scan time (not the submission time) decides freshness and ordering. An older report never replaces a newer one.
- Anyone can submit a report for any public site, as anyone can scan any site. The board shows what a scan measured, not who owns the site. Because ranks are about public behaviour, this lets a fan or a competitor update a standing, but not change what the scan found.
- Known limits: a site that serves the scanner different content cannot be detected; a site can lower its score on purpose, join, and then fix it to look like a climber (XP and the Climbers board are only paid for points above its own best, but the 30-day gain is not); many throwaway domains from many clients can crowd the lower ranks (the store keeps at most 2000 standings and drops the lowest XP first).
- Ranks are computed when the page is read, from the current standings, so they cannot go stale; dormant sites (60 days without a re-scan) leave the boards.

## Moderation and abuse

- Submissions are rate limited per client (30 an hour per instance) and need the site's own origin for form posts.
- Ownership of the site is not verified: anyone can submit a report for any public domain, as with scanning. The board only shows what a scan measured, but a reader should not take a listing as the owner's endorsement.
- Removal today: the pages tell owners to open an issue with the host name; a maintainer then removes the listing with the admin route. Removal leaves a tombstone, so a submission cannot add the host straight back (403); an admin lifts it on purpose with `POST /api/league/{host}/restore`. A durable owner-verified opt-out (a `/.well-known` file or robots-style rule the scanner reads) is the follow-up.
- Where the removal link goes: `LEAGUE_REMOVAL_URL` (default `https://github.com/webmaxru/agent-ready-check/issues/new`, the repository's own issue form; `github.com/vibeprogrammer/agent-ready-check` redirects to it). A fork or a hosted instance should set its own tracker or contact form.
- Set `LEAGUE_ADMIN_TOKEN` to enable `DELETE /api/league/{host}` and `POST /api/league/{host}/restore` (bearer token). Without the token both routes answer 404. On Azure, the deploy scripts and the Deploy infra workflow keep the deployed `LEAGUE_ADMIN_TOKEN` and `LEAGUE_REMOVAL_URL` when they are not supplied; clear them on purpose with `--clear-league-settings` (`deploy.sh`), `-ClearLeagueSettings` (`deploy.ps1`) or the workflow's `clear_league_settings` input.
- Follow-ups worth doing: owner verification (a `/.well-known` file or meta tag) before a site may opt out or claim a name, and a self-service opt-out.

## Design notes

The pages use the pixel theme from `docs/DESIGN.md`. The join celebration (confetti, count-up) lives in `/assets/league.js`, is progressive enhancement, and is skipped under `prefers-reduced-motion`. Division chips pair a fill with an ink text colour for at least 4.5:1 contrast.
