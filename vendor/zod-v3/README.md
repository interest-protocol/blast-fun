# Zod 3 collection-limit security backport

Some current Pyth, Privy, Coinbase and wallet SDKs still require Zod 3. Their
Zod 3 schemas cannot safely be replaced with Zod 4. There is no patched stable
Zod 3 release for [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

This private fork is the unmodified npm `zod@3.25.76` distribution plus the
reviewable `security.patch`, adapting the [upstream fix](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd). It keeps the upstream MIT license, declarations,
exports and SDK APIs. The distinct `@blast/zod-v3@3.25.76` name records
that Blast maintains the backport; it is not an upstream release or an audit
exception. The root file dependency supplies SDKs whose Zod 3 ranges it satisfies. A
narrow override also replaces AppKit Wallet's exact older pin. Zod 4 consumers
keep their patched upstream dependency; a scoped Vercel override repairs its
exact old Zod 4 pin. This avoids forcing either major through incompatible peers.

- Zod 3 arrays and sets already report bound errors before walking elements,
  but continue parsing every element. Return the failed parse immediately
  when `.max()`, `.length()` or `.size()` rejects an oversized collection.
  Abort downstream refinements because their input has not been parsed.
- The distribution also exposes an early Zod 4 implementation. Check its
  collection bounds before allocating output or walking array/set/map entries.
  Run the original bound check, including its condition and error settings,
  so disabled bounds still allow ordinary element validation. Only leading size
  checks run early; preceding value rewrites keep their declared order and
  mismatched collection types retain their ordinary type error.
- Patch TypeScript sources and both ESM/CommonJS output. No install hooks,
  dependency changes, generated declarations or scanner suppressions.

`bash vendor/zod-v3/rebuild.sh` fetches the pinned upstream tarball, verifies its
SHA-512, applies the patch and reproduces the deterministic archive. Its SHA-256
is `d034064d4053606f72c8333fc1c8e9b3e988ed1cd8a98bb0dba36c6d9bc3d32f`.
Run `node --test scripts/zod-collection-limits.test.mjs` for the installed-copy
regressions, including synchronous/asynchronous parsing and both module formats.
The Docker build includes the archive so production `npm ci --ignore-scripts`
installs the same reviewed code.

Remove this fork and its override when every Zod 3 consumer can use a patched
upstream release. Recheck all exports and these regressions before rebasing it.
