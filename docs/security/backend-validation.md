# Backend validation

Zod is the runtime validator for backend request bodies, parameters, stored job
payloads, provider responses, configuration, and HTTP/WebSocket contract decoders.
Keep schemas beside their owning boundary and infer request types where practical.
SDK decoders, cryptographic verification, resource limits, and domain rules remain
in their existing owners; Zod does not replace those checks.

## Published JSON contracts

The seven presale JSON request schemas and their shared primitive definitions are
generated from Zod. Run `npm run contracts:generate -w @blast/core` after changing
those sources, then `npm run contracts:check -w @blast/core`. Published response
schemas remain independent JSON contracts. Preserve their identifiers, references,
unknown-field policy, optional fields, and accepted wire values.

A wire schema can deliberately accept more than a submission schema: for example,
the published base64 pattern is broader than runtime canonical-padding checks.
Keep these distinctions explicit rather than silently changing external contracts.

## Ajv is tooling only

Ajv independently tests the generated or published JSON Schema artifacts. It is a
development dependency, not an alternative runtime validator. Runtime code must
not import Ajv, the presale/social `contracts/validate.ts` wrappers, or presale
`schema-branches.ts`. `scripts/validation-boundary.test.mjs`, included in the root
`npm test`, checks static imports, re-exports, literal dynamic imports, and literal
`require` calls across application/package source and scripts. Tests, the three named
tooling implementations, and the partner API live contract probe are explicit
exceptions. Add a tooling exception deliberately rather than importing Ajv into
a runtime handler.

Avoid parsing an object into a permissive intermediate schema before validating
its closed shape: Zod can omit an own `__proto__` key while copying an object.
Validate strict schemas against the original input. Preserve explicit output
construction for signed or hashed payloads, where object-key order matters.
