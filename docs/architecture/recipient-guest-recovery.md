# Canonical recipients and retained guest drafts

Normal Create requests, reads and guest restore use canonical recipient fields
`cliff` and `duration`, with the existing optional unit defaults. They reject
retired or mixed recipient keys. The exact old grammar exists only in the
explicit versioned offline migration artifact and synthetic migration fixtures.
Database representation cutover is documented separately in
[recipient-draft-migration.md](recipient-draft-migration.md).

The current browser draft is a strict canonical envelope under sessionStorage
`blast:create:guest-draft:v1`, with schema `blast.social-create-guest-draft`,
version `1` and `draft`. Its optional `recovered_from` is a SHA256 source receipt.
The unversioned `blast:create:guest-draft` remains opaque retained input, even
when its body might already be canonical. Ordinary restore never translates it.
The unrelated launchpad localStorage v2/archive and account/session/quota owners
are unchanged.

Restore distinguishes empty, canonical, recovery required and unavailable
storage. Failed JSON, unknown envelopes, conflicting copies and changed raw
bytes stay recoverable; they never turn into an empty draft. While unresolved,
new-draft saving and browser persistence pause. Account loading continues. A
creator may explicitly keep editing an already saved account draft without
writing or deleting the retained guest copies.

The recovery card exports each exact raw copy. Operators can use the isolated
[offline recovery CLI](../../scripts/migrations/recipient-draft-v1/README.md)
to prepare a canonical envelope bound to the complete UTF-8 export bytes.
Import requires its receipt to match the retained source; an unrelated file,
missing receipt or existing newer canonical copy is refused before writing.
Both-copy conflicts retain both and require review; import never chooses a
winner. No runtime or browser bundle imports the offline converter.

The imported envelope and receipt are written together, then read back before
the UI offers explicit adoption. The old raw copy remains. A changed source,
quota error, failed write or readback mismatch prevents adoption and preserves
the source. A crash after a completed envelope write can restore the matching
receipt without executing old grammar. Hash work occurs during restore or
explicit recovery, never on each typing update.

Selecting a recovery file does not replace the mounted form. Explicit adoption
is a separate action. Unsaved changes in either a guest or account draft, and
in-flight saves or uploads, must finish first;
a clean loaded account draft becomes a separate new draft, leaving its original
durable row and identity untouched. Existing account ID/session and normal
authentication/save/quota contracts remain in use. There is no account creation
or chain transaction in recovery.

Account verification gates saved allowlist reads as well as draft loading and
autosave. A first save needed for an image upload uses the same serialization
as autosave; edits typed while it is pending save afterward. Leaving recovery
resumes pending dirty work without requiring another edit.

Only an acknowledged normal account save of the adopted guest draft can clear
its matching guest copies. Unresolved, unadopted or changed copies never clear.
Guest-only adoption and failed/in-flight saves retain the source. Two-copy
cleanup writes a verified acknowledgement before either removal; single-copy
cleanup can atomically remove its exact canonical key when write quota prevents
adding a receipt. A tab-local saved-copy receipt also survives starting another
draft for the same account, and is cleared when account ownership changes. Each write or
removal checks both current strings against the inspected snapshot first. Web
Storage cannot provide a cross-process transaction: a write/readback failure
remains an explicit recovery state, not a successful save. Isolated later tabs,
browser storage eviction and unknown retained sessions cannot be inventoried or
proven safe by a server migration.

This change does not claim actual retained-data migration, hosted readiness or
complete architecture acceptance. Local unit, physical database, type and
browser/UI gates must be recorded against their exact source. UI uses existing
BLAST card/button tokens and introduces no motion. Required visual widths are
320, 407, 768, 1054 and 1414 pixels with keyboard and reduced-motion checks.
