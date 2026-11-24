import { SuiGrpcClient } from "@mysten/sui/grpc";

/** The Sui client every worker reads and submits through. Unselected, a worker blocks before any node call. */
export function mainnetClient(baseUrl: string): SuiGrpcClient {
  return new SuiGrpcClient({ network: "mainnet", baseUrl, format: "text" });
}
