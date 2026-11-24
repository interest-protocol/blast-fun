import type { Pool } from 'pg';
import type { SocialPortfolio } from '../../../../packages/core/src/modules/social/contracts/portfolio.ts';
export function startWalletHttp(admin: Pool, databaseUrl: string): Promise<{
  read(n: number, instance: number): Promise<SocialPortfolio>;
  close(): Promise<void>;
}>;
