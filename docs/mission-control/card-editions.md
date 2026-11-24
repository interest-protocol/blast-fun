# Crew card editions

Card version 3 uses the approved BLAST-handoff-v3 landscape artwork. The server
assigns the edition from the crew number allocated during atomic completion.
The completion request accepts a role title, with no style or edition choice.
There is no legacy card renderer or record conversion.

| Crew numbers | Edition |
| --- | --- |
| 1–25 | Quasar |
| 26–50 | Cosmic |
| 51–100 | Prism |
| 101–150 | Pearl |
| 151–200 | Aurora |
| 201–300 | Silver |
| 301–500 | Bronze |
| 501–1000 | Lunar |
| 1001+ | Recruit |

Exactly 69 receives Manifest, exactly 123 receives Countdown, exactly 256 receives
8-Bit, exactly 503 receives Sui, and exactly 727 receives Blast Launch Day. All
five are 1-of-1 editions, and these exceptions take
priority over the normal range assignment. Assignment is centralized
in `apps/web/src/modules/mission-control/card-renderer/editions.ts`. Fleet membership and
its early-member status do not affect card artwork.

The owner card endpoint returns a 2100×1500 PNG; `?format=share` returns the
handoff's 1200×675 X-post composition. Both are authenticated and `private,
no-store`. Personal images are generated from the approved avatar snapshot,
callsign, role, and crew number. Published cards stay available at `/card/:id`
even while the interactive Mission Control experience is hidden. The page shows
the full 2100×1500 card while link-preview metadata keeps the 1200×675 X layout.

New claims snapshot the original X profile image rather than its 48×48
`_normal` thumbnail. Existing low-resolution snapshots recover the larger photo
from the saved X image reference on a render-cache miss, for every edition and
both image formats. The claimed identity record is not modified. Renderer
version 3 invalidates earlier cached thumbnails. Temporary provider failures
remain retryable; a permanently deleted original retains the saved snapshot.

Fixed artwork is baked into fourteen PNG backgrounds in
`packages/server/assets/mission-control/editions/`. Only those backgrounds are
cached in memory. Generate them with:

```sh
node --no-warnings --experimental-strip-types packages/server/scripts/generate-card-backgrounds.ts
```

The procedural artwork comes from the handoff's `source/launch-kit.js`; the
runtime adaptation removes the old palettes, manual overrides, and browser-only
utilities. The `brand-paths.json` file contains the supplied helmet and wordmark.

For this preview reset, clear runtime data with `npm run db:reset -w @blast/web` before applying
migration `0015_card_editions`, which accepts only record version 3. The reset
preserves migration history, reserved callsigns, and reusable sticky access
codes. It resets crew allocation and removes profiles, cards, and sessions.
