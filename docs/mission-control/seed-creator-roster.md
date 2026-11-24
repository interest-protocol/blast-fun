# Seed Creator Roster

Recorded on 2026-09-24 for the initial Mission Control launch-code distribution.

Historical roster for the retired Season Zero invitation campaign. Keep plaintext code records in their existing restricted storage.

## Attribution model

- A Seed Creator exists before signup and is identified initially by an expected, case-insensitive X handle.
- An Initial Code belongs to the Seed Creator record, not directly to a wallet or an unverified profile.
- A Community Code Group preserves the community label while linking its codes to the representing Seed Creator's X identity.
- Every redemption records both the code and the Blast Account that consumed it.
- When the expected X account authenticates, its stable X subject claims the Seed Creator record and links it to that Blast Account. The verified X subject becomes authoritative; the handle remains a changeable snapshot.
- If a Seed Creator redeems one of their own Initial Codes, retain the consumption record but do not create Recruit Attribution to themself.

## Roster

| Creator | Expected X handle | Canonical X URL | Status / note |
| --- | --- | --- | --- |
| Leon | `@leonnguyen444` | https://x.com/leonnguyen444 | Ready |
| William | `@williamm168` | https://x.com/williamm168 | Ready |
| Bardbard | `@BardBard` | https://x.com/BardBard | Ready |
| Doncurrent | `@doncurrent` | https://x.com/doncurrent | Ready |
| Chocolate | `@chocolate_xo3` | https://x.com/chocolate_xo3 | Ready |
| Funkii | `@funkii` | https://x.com/funkii | Ready |
| Dave | `@davedotsui` | https://x.com/davedotsui | Ready |
| YoBoogie | `@YoBooogie` | https://x.com/YoBooogie | Ready; handle contains three consecutive `o` characters after `B` in the supplied value |
| Kotaro | `@_smkotaro` | https://x.com/_smkotaro | Ready |
| Ed | `@EdCriptoFi` | https://x.com/EdCriptoFi | Ready |
| Airtx | `@0xairtx` | https://x.com/0xairtx | Ready |
| David | `@eyezenhour` | https://x.com/eyezenhour | Ready |
| Wara | `@0xWara` | https://x.com/0xWara | Ready |
| Kropts | `@kropts` | https://x.com/kropts | Ready |
| Mikecantmiss | `@mikecantmiss` | https://x.com/mikecantmiss | Ready |
| Morons / Mirai | `@_smkotaro` | https://x.com/_smkotaro | Community code group represented by Kotaro |
| Neppah | `@neppahtitel` | https://x.com/neppahtitel | Ready |
| Bread | `@MrBreadSmith` | https://x.com/MrBreadSmith | Ready |
| Angelo | `@angelodotsui` | https://x.com/angelodotsui | Ready |
| Iroh | `@irohgmi` | https://x.com/irohgmi | Ready |
| Pika | `@pikapikasui` | https://x.com/pikapikasui | Ready |
| Harry | `@HarryPerps` | https://x.com/HarryPerps | Ready |
| Death | `@0xd34th` | https://x.com/0xd34th | Ready |
| Eman | `@EmanAbio` | https://x.com/EmanAbio | Ready |
| Christina | `@unceenc` | https://x.com/unceenc | Ready |
| Calz | `@_smcalz` | https://x.com/_smcalz | Ready |
| Satoshi | `@SatoshiMedici` | https://x.com/SatoshiMedici | Ready |
| Sui Legend | `@TheSuiLegend` | https://x.com/TheSuiLegend | Ready |
| Wale | `@tweetbywale` | https://x.com/tweetbywale | Ready; tracking query removed |
| Teddy | `@teddi_speaks` | https://x.com/teddi_speaks | Ready; tracking query removed |
| CryptoMama | `@1cryptomama` | https://x.com/1cryptomama | Ready; tracking query removed |
| Echoes | `@saksidasaksi` | https://x.com/saksidasaksi | Ready |
| Moonboy | `@Se7enDigtzOrDie` | https://x.com/Se7enDigtzOrDie | Ready |
| JimmyC | `@JimmyC_4` | https://x.com/JimmyC_4 | Ready |
| JTC | `@JTCdev` | https://x.com/JTCdev | Ready |
| Frenchy | `@frenchymeta` | https://x.com/frenchymeta | Ready |
| Stanx | `@Big_stanx` | https://x.com/Big_stanx | Ready |
| Capo | `@basedmobster` | https://x.com/basedmobster | Ready |
| ManVan | `@vanxan` | https://x.com/vanxan | Represents the Doonies community code group |
| Jose | `@josemvcerqueira` | https://x.com/josemvcerqueira | Ready |
| Nef | `@Nefarii` | https://x.com/Nefarii | Ready |
| Cussy | `@Cussysss` | https://x.com/Cussysss | Ready |
| Ryuzi | `@richie_binance` | https://x.com/richie_binance | Ready |
| Nobs | `@nobsfud` | https://x.com/nobsfud | Ready |
| Alex | `@alexanderbits` | https://x.com/alexanderbits | Ready |
| Illu | `@illuminfti` | https://x.com/illuminfti | Ready |

## Import conventions

- Preserve the supplied display label separately from the X handle.
- Store a normalized handle without `@`, lowercased for matching and uniqueness.
- Do not treat capitalization or URL query parameters as identity.
- Do not bind a creator to a Blast Account from the handle alone. Binding requires a verified X login and stores the stable provider subject.

## First-wave code inventory

Received on 2026-09-25:

- 173 unique Initial Codes across 34 Seed Creators.
- Eman, Christina, and Satoshi are included as Seed Creators with zero first-wave codes.
- 33 creators have five codes each.
- Kotaro has eight codes, including the separately supplied final code.
- No first-wave codes were supplied for Morons, Eman, Christina, or Satoshi. The later Mirai community allocation is represented by Kotaro.
- The importer is idempotent: re-running it retains matching assignments and refuses conflicting ownership.

## Community-wave code inventory

Received on 2026-09-25:

| Community code group | Representing X identity | Code count |
| --- | --- | ---: |
| Mirai | Kotaro / `@_smkotaro` | 20 (`MIRA-XXXX`) |
| Eman | Eman / `@EmanAbio` | 20 |
| Sui Gays/Sui Traders | Iroh / `@irohgmi` | 10 |
| Lofi The Yeti | David / `@eyezenhour` | 10 |
| Serp | Frenchy / `@frenchymeta` | 5 |
| Doonies | ManVan / `@vanxan` | 10 |

The community wave contains 75 codes. All are canonical `XXXX-XXXX`; the 20 originally supplied as `MIR-XXXX` were confirmed and converted to `MIRA-XXXX` before import.

## Additional creator-wave inventory

Received on 2026-09-25:

| Creator | X identity | Newly imported | Durable total for group |
| --- | --- | ---: | ---: |
| Satoshi | `@SatoshiMedici` | 20 | 20 |
| Kotaro | `@_smkotaro` | 41 | 49 |
| Bread | `@MrBreadSmith` | 20 | 25 |
| Jose | `@josemvcerqueira` | 30 | 30 |
| Nef | `@Nefarii` | 20 | 20 |
| Cussy | `@Cussysss` | 10 | 10 |
| Ryuzi | `@richie_binance` | 5 | 5 |
| Nobs | `@nobsfud` | 15 | 15 |
| Alex | `@alexanderbits` | 10 | 10 |
| Illu | `@illuminfti` | 10 | 10 |

## Luma allocation

Received on 2026-09-25:

| Code group | Representing X identity | Code count |
| --- | --- | ---: |
| Luma | Satoshi / `@SatoshiMedici` | 500 |

The configured database currently contains 929 creator `XXXX-XXXX` codes, all matched to the private recovery source. Custom, database-backed codes are canonical eight-character assignments but are not required to satisfy the generated-code checksum. Jose's 30 codes and Nef's allocation are bound to their supplied X handles, the Luma allocation belongs to Satoshi's existing Seed Creator identity, the Mirai allocation belongs to Kotaro's identity, Cussy has 10 assigned codes, Ryuzi has 5, Nobs has 15, Alex has 10, and Illu has 10.

## Pending input

- Codes for Christina, if she is intended to receive an allocation.
