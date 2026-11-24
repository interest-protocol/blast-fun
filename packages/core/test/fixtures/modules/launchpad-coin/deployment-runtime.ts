import { packageVersionBcs } from "@interest-protocol/blast-admin-sdk/state";
import type { BlastDeploymentInput, DeploymentRuntimeObservation } from "@interest-protocol/blast-deployments-sdk";

/**
 * What a node reports for a manifest: its chain, every shared object at its
 * expected type, and each pausable package's `paused` mask (`paused`, all
 * zero by default).
 */
export function runtimeFor(
  input: BlastDeploymentInput,
  paused: Readonly<Record<string, number>> = {},
): DeploymentRuntimeObservation {
  const original = (name: string) =>
    input.packages[name]?.originalPackageId ?? "0x0";
  const admin = original("admin");
  const otw = (group: string, module: string, name: string) =>
    `${original(group)}::${module}::${name}`;
  const administered = (group: string, module: string, name: string) => ({
    [`${group}.packageVersion`]: `${admin}::package_version::PackageVersion<${otw(group, module, name)}>`,
    [`${group}.packageAdmin`]: `${admin}::package_admin::PackageAdmin<${otw(group, module, name)}>`,
  });
  const types: Record<string, string> = {
    "admin.acl": `${admin}::blast_acl::ACL`,
    "core.treasury": `${original("core")}::blast_treasury::Treasury`,
    "vault.registry": `${original("vault")}::blast_vault_package::VaultRegistry`,
    ...administered("vault", "blast_vault_package", "BLAST_VAULT_PACKAGE"),
    ...administered("launchpad", "blast_fun", "BLAST_FUN"),
    "launchpad.launchConfig": `${original("launchpad")}::launch_config::LaunchConfig`,
    "launchpad.runtimeConfig": `${original("launchpad")}::runtime_config::RuntimeConfig`,
    "launchpad.launchRegistry": `${original("launchpad")}::launch::LaunchRegistry`,
    ...administered(
      "presale",
      "blast_presale_package",
      "BLAST_PRESALE_PACKAGE",
    ),
    "presale.creationPolicy": `${original("presale")}::creation_policy::CreationPolicy`,
    "presale.feePolicy": `${original("presale")}::fee_policy::FeePolicy`,
    "presale.presaleRegistry": `${original("presale")}::blast_presale::PresaleRegistry`,
    ...administered("migrators", "blast_migrators", "BLAST_MIGRATORS"),
    "migrators.venueConfig": `${original("migrators")}::venue_config::VenueConfig`,
    "cetus.config": `${original("cetusClmm")}::config::GlobalConfig`,
    "cetus.pools": `${original("cetusClmm")}::factory::Pools`,
    "cetus.burnManager": `${original("cetusLpBurn")}::lp_burn::BurnManager`,
    "bluefin.config": `${original("bluefinSpot")}::config::GlobalConfig`,
    "aftermath.poolRegistry": `${original("aftermathAmm")}::pool_registry::PoolRegistry`,
    "aftermath.daoFeeVersion": `${original("aftermathDaoFee")}::version::Version`,
  };
  const pausable = ["vault", "launchpad", "presale", "migrators"];
  return {
    chainIdentifier: input.chainIdentifier,
    sharedObjects: Object.fromEntries(
      Object.entries(input.sharedObjects).flatMap(([group, objects]) =>
        Object.entries(objects).map(([name, identity]) => {
          const path = `${group}.${name}`;
          return [
            path,
            {
              objectId: identity.objectId,
              type: types[path] ?? "0x2::object::UID",
              initialSharedVersion: String(identity.initialSharedVersion),
              ...(name === "packageVersion" && pausable.includes(group)
                ? { paused: paused[group] ?? 0 }
                : {}),
            },
          ];
        }),
      ),
    ),
  };
}

export function fixtureSharedContent(path: string, objectId: string): Uint8Array {
  if (!path.endsWith(".packageVersion")) return new Uint8Array();
  return packageVersionBcs.serialize({
    id: { id: { bytes: objectId } },
    valid_pause_bits: 7,
    paused: 0,
    package_witness: "0x1::dummy::DUMMY",
    version: 1n,
  }).toBytes();
}
