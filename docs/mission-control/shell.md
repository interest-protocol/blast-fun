# Mission Control shell

The root route owns the production Mission Control shell. It does not execute
or embed the prototype HTML. Desktop uses the reviewed room geometry and two
real power buttons; view changes are hard cuts. Below 768px, only the CRT is
rendered. The state machine and mount types live beside
`MissionControlShell.tsx`.

## Consumer contract

- Shell phases: `off`, `waiting-for-flash`, `flash`, `terminal`, `collapsing`.
- Product mounts: `locked`, `code`, `restore`, `admitted`, `onboarding`,
  `owner`.
- A power action increments the client epoch and clears the pending timer.
  This cancels client work only; it never deletes a server session.
- Terminal slots may be supplied through `slots`. `onMountRequest` lets a
  later controller own routing without changing room or CRT composition.
- Status changes are announced through one polite live region. Focus moves to
  the primary locked action after boot, to reserved-panel recovery after a
  mount change, and back to the initiating power button after shutdown.

## Browser harness

From the repository root, run `npm run dev -w @blast/web`, then verify `/` at widths 320, 375, 407, 768,
1054, and 1414. Exercise both desktop power controls, mobile power, keyboard
focus, power-off during each boot phase, and both reduced-motion settings.
Confirm `/closed` redirects to `/`, old product routes render the root shell,
and the CRT remains usable with CSS masking disabled in Safari Web Inspector.

The reviewed timings are 420ms to flash, 900ms flash duration, 150ms CRT
collapse, and 250ms interaction release. Reduced motion skips these waits and
the delayed power-control pulse.

## Asset and rights release checklist

| Public asset | Source / status | Swap boundary | Release check |
| --- | --- | --- | --- |
| `bedroom-night-2000.png` | Handoff AI-generated / AI-edited room | Same URL and 2400:1792 geometry | Review the console-like shelf object and approve generated imagery rights |
| `screen-mask.png` | Handoff measured CRT alpha mask | Same URL and screen geometry | Verify mask and flat-glass fallback in Safari |
| `blast-girl-line.svg` | Handoff trace used only for boot flash | Same 1:1 vector slot | Replace traced art with final approved vector master |
| `/blast-helmet.svg` | Existing BLAST helmet hook | Same intrinsic slot | Confirm it is the final brand vector master |
| `sui-mark.svg` | Handoff Sui mark, reserved for later mounts | Same URL | Confirm current Sui brand usage approval before display |

The public shell contains no sample X handles, sample profile photos, prototype
test codes, TV clip, remote fonts, or runtime prototype state. The room image
contains baked generated props; those rights and likeness checks remain a
release gate, not an engineering assumption.
