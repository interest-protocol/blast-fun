import type { SponsorDerivedCall } from "./policy.ts";

/**
 * The Aftermath DAO-fee swap the trade intent sponsors (social trades,
 * `social/trades/aftermath.ts`): `swap::swap_exact_in` of Aftermath's DAO-fee
 * package on mainnet, the one call that swaps in a Blast sale's DAO-fee pool
 * (contracts ADR 0104). Unlike the Cetus aggregator's targets
 * (`PRESALE_SPONSOR_SWAP_TARGETS`), it is pinned here, whole: the package,
 * the function, its counts, and every shared object but the pool. The pool
 * (argument 0, the `DaoFeePool` wrapper) stays unconstrained, as a Cetus
 * route's pool does (accepted residual B-005). An Aftermath upgrade that
 * moves the package or an object makes these trades refused until this file
 * is updated and reviewed. The trade path builds its call from these same
 * objects; `aftermath-dao.test.ts` holds them equal to the Cetus
 * aggregator's own `aftermath::swap` pins.
 */

/** Aftermath's mainnet objects for the DAO-fee swap, as `swap::swap_exact_in` takes them. */
export const AFTERMATH_DAO = Object.freeze({
  /** The DAO-fee package `swap::swap_exact_in` is called at (its current published version). */
  package: "0x5ad6890968efcf3d20899e0cec735214f1067b96e77e77d86408989998468bb2",
  /** Where `pool::DaoFeePool` and `version::Version` were defined. */
  typeOrigin: "0x6f60a091637054e23915b8745c0c0d47b1d49618ee3435b5f68eccf6a44fb53d",
  /** Where the AMM's `pool::Pool` was defined. */
  ammTypeOrigin: "0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c",
  /** The AMM package the swap runs in, where its slippage abort is raised. */
  ammPackage: "0xf948935b111990c2b604900c9b2eeb8f24dcf9868a45d1ea1653a5f282c10e29",
  /** The type of the protocol fee vault. */
  vaultType: "0x2d9316f1f1a95f6d7c85a4e690ef7c359e6649773ef2c37ad7d9857adb6bef06::vault::ProtocolFeeVault",
  version: "0xb4bfb0f917f12ad2a772bea9b4f22431f6f5f9653162c3ae6fae5b99b21392b7",
  registry: "0xfcc774493db2c45c79f688f88d28023a3e7d98e4ee9f48bbf5c7990f651577ae",
  vault: "0xf194d9b1bcad972e45a7dd67dd49b3ee1e3357a00a50850c52cd51bb450e13b4",
  treasury: "0x28e499dff5e864a2eafe476269a4f5035f1c16f338da7be18b103499abf271ce",
  insuranceFund: "0xf0c40d67b078000e18032334c3325c47b9ec9f3d9ae4128be820d54663d14e3b",
  referralVault: "0x35d35b0e5b177593d8c3a801462485572fc30861e6ce96a55af6dc4730709278",
} as const);

/** Aftermath's DAO-fee package, at its current published version. */
export const AFTERMATH_DAO_PACKAGE = AFTERMATH_DAO.package;

/** The swap function, as `<module>::<function>`. */
export const AFTERMATH_DAO_SWAP = "swap::swap_exact_in";

/**
 * `swap_exact_in<Lp, CoinIn, CoinOut>(dao_fee_pool, version, pool_registry,
 * protocol_fee_vault, treasury, insurance_fund, referral_vault, coin_in,
 * expected_coin_out, allowable_slippage)`: the coin is an earlier command's
 * result (the resolver's split, or a Cetus leg's output), the two amounts
 * pure `u64`s.
 */
export const AFTERMATH_DAO_SWAP_CALL: SponsorDerivedCall = {
  target: AFTERMATH_DAO_SWAP,
  argumentCount: 10,
  typeArgumentCount: 3,
  argumentKinds: [["shared"], ["shared"], ["shared"], ["shared"], ["shared"], ["shared"], ["shared"], ["result"], ["pure"], ["pure"]],
  recipientArguments: [],
  fixedArguments: [],
  sharedObjects: [
    { position: 0, objectId: null },
    { position: 1, objectId: AFTERMATH_DAO.version },
    { position: 2, objectId: AFTERMATH_DAO.registry },
    { position: 3, objectId: AFTERMATH_DAO.vault },
    { position: 4, objectId: AFTERMATH_DAO.treasury },
    { position: 5, objectId: AFTERMATH_DAO.insuranceFund },
    { position: 6, objectId: AFTERMATH_DAO.referralVault },
  ],
};
