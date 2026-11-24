import assert from "node:assert/strict";
import test from "node:test";
import { BLAST_DEPLOYMENTS, presaleDeployment } from "@interest-protocol/blast-sdk/deployments";
import { deserialize } from "@mysten/move-bytecode-template";
import { fromBase64 } from "@mysten/sui/utils";
import { bcs } from "@mysten/sui/bcs";

import { presaleCoinTemplate } from "@blast/server/modules/social/create/coin-template.ts";

for (const decimals of [6, 9]) {
  test(`the ${decimals}-decimal presale coin publishes the processed logo with a sealed treasury`, async () => {
    const deployment = presaleDeployment(BLAST_DEPLOYMENTS.mainnet!);
    const iconUrl = "https://assets.public.blob.vercel-storage.com/logos/processed.webp";
    const packageData = await presaleCoinTemplate.bytecode(
      {
        name: "Meridian",
        symbol: "MRDN",
        description: "A small coin",
        iconUrl,
        decimals,
      },
      deployment,
    );
    const coinModule = deserialize(fromBase64(packageData.modules[0]!));
    assert.ok(coinModule.identifiers.includes("mrdn"));
    assert.ok(coinModule.identifiers.includes("MRDN"));
    assert.deepEqual(coinModule.constant_pool[3].data, [
      ...bcs.string().serialize(iconUrl).toBytes(),
    ]);
    assert.deepEqual(coinModule.constant_pool[4].data, [decimals]);
    assert.ok(coinModule.identifiers.includes("sealed_treasury_cap"));
    assert.equal(packageData.dependencies.at(-2), deployment.core.packageId);
    assert.equal(packageData.dependencies.at(-1), deployment.packageId);
  });
}
