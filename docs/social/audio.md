# Blast web audio

The speaker beside Search opens the Audio menu. Sound effects start on and remember the reader’s choice. An independently opened Blast tab starts with background music off. Once on, it continues through in-app navigation and while the reader uses another tab. The tab remembers the setting on reload. If the browser blocks autoplay, the music starts at the next click, tap or key press that allows playback.

| Page or surface | Action | Sound |
| --- | --- | --- |
| All pages in the app shell | Open a page, press a button or select a tab | Soft glide when the page changes. Short tap for ordinary controls. |
| All pages in the app shell | Open or close Search, a menu or a sheet, or change a switch | Soft up or down motion cue. Sheets that appear on their own stay silent. |
| Home `/` and `/feed`, post `/p/[postId]`, profiles `/@[callsign]` and their follower and following lists | Open, react, reply, share, post, follow or unfollow | Soft taps for controls. A short rising or falling phrase for follow and unfollow. Feed refreshes and social counts stay silent. |
| Bonding `/bonding`, presale list `/presale`, and Blast workspace on Home | Browse, filter, sort, expand details or pick a market | Soft control sounds. Bulk price, volume and activity updates stay silent. |
| Coin `/coin/[coinKey]` and presale `/presale/[presaleId]` | A new live trade reaches the displayed market | Background tick. Buy ticks rise and sell ticks fall. At most one tick every 1.2 seconds. Historical rows and reconnect batches stay silent. |
| Coin and presale pages, workspace, portfolio and the site-wide Swap sheet | Confirm a buy or sell | Clear two-note rise for a buy or fall for a sell. Quote changes, pending signatures and cancelled wallet prompts stay silent. The Swap sheet uses two lower notes for a refused trade. |
| Presale and commitment sheet | Charge, release and confirm a commitment | Notes rise during the hold, a short sweep on release, and a separate two-note landing once confirmed. A failed commitment gets two lower notes. |
| Portfolio and tabs `/portfolio/{presales,claims,launches,rewards,vestings}`, vesting `/vesting` and `/vesting/[scheduleId]`, coin and presale claim actions | Manage positions, view balances, claim or request a refund | Soft control sounds and a clear three-note cue for a confirmed claim or refund. Balances, accrual and pending claims stay silent. |
| Competitions `/competitions` and `/competitions/[slug]` | Browse rules and standings, or trade | Soft control sounds and normal confirmed-trade cues. The timer and standings refreshes stay silent. |
| Notifications `/notifications` and the header bell | Open or read a notification, or receive a new one | Soft control sounds and a quiet bell for a new delivery. Existing unread counts, catch-up reads and hidden tabs stay silent. |
| Create presale `/create`, launch coin `/launch`, create vesting `/vesting/new`, allowlist tool `/presale/allowlists/new` | Fill fields, upload, preview or submit | Soft control sounds. Typing, validation and wizard progress stay silent. |
| Settings `/settings`, sign-in `/sign-in`, invites `/invites`, presale receipt `/presale/[presaleId]/receipt/[wallet]` | Change a setting, sign in, copy, share or inspect | Soft control sounds. Typing, loading and passive account status stay silent. |
| Legal pages, share-card pages and the fallback terminal at `/` when the app is disabled | Read or share | Silent. |

Effects wait for the first gesture, stay silent in hidden tabs and use the browser’s synthesizer. The music is Mission Control’s *Cozy Vinyl Groove*, from the source `cozy-vinyl-groove.wav` in Blast history at `9b6bb418f`. The WAV’s embedded metadata identifies it as made with Suno. The full 188-second track is a quiet, 48 kbps stereo MP3 of 1,129,536 bytes. The browser sets the media URL when the reader turns on music or the saved setting is on. Effects, playback and the action map add no API requests. Music uses a static file that the browser can fetch in ranges.
