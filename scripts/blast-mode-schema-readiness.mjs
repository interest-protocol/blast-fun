import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/package.json');
const { Client } = require('pg');

// Exact local-final up-migration names and checksums; no SQL body or user data.
const expectedMigrations = [
  {
    "name": "0001_mission_control_foundation",
    "checksum": "8acfd97c8bf1d63cfbda4383a53a2887dcbcafb6244a7c5e726b6e249d1f3bc9"
  },
  {
    "name": "0002_wallet_challenges",
    "checksum": "13b6baf32c7ae8987ef9f95d6c90b318c41bac5961b335f80a11681704645812"
  },
  {
    "name": "0003_profile_season_membership",
    "checksum": "e12221ca90133c314806f699bb44fca400e742f6a6fdbc86f7d8b1ae1c045359"
  },
  {
    "name": "0004_season_cutoff",
    "checksum": "c4d00ea29f2c5669017d46179823b90dea56de479b4614372b2f5f0f97272aca"
  },
  {
    "name": "0005_web_security",
    "checksum": "fa19613294db0e4b4b697c9a9b0e6514928be5e9475fe77604fda6b5cb509409"
  },
  {
    "name": "0006_member_sessions",
    "checksum": "559bd3d2b81d0885a9c5b7982616292dfff790b37c13f0943f85a033476f9f8c"
  },
  {
    "name": "0007_nuclear_code_admission",
    "checksum": "d0d1915cb5998954a5181b71ff0f446bc65430f7f17ddde545f74a70eee89e53"
  },
  {
    "name": "0008_operator_actions",
    "checksum": "7b8a50118ced8a2a7bf1e65612c861478f3c065edcc6df0cab651e634572f183"
  },
  {
    "name": "0009_atomic_completion",
    "checksum": "56fee075d955ee20d308cc4739c18d06d8d7e11c85b2fee217a1ef1e23356132"
  },
  {
    "name": "0010_telemetry_projection",
    "checksum": "d2207b18aaf9b1d6c1ff2dfd984e14425ea01cca4b760ebcc02dd434e32cc9d0"
  },
  {
    "name": "0011_preview_master_admission",
    "checksum": "4e919076b677fbfea7d34902ccd83b049621e67ca057b09e5e9ad44fe7be8d29"
  },
  {
    "name": "0012_canonical_blast_accounts",
    "checksum": "baacafe29b00583d4d94d7672cea189df0cb81fd82023e0062d21a944a6f223b"
  },
  {
    "name": "0013_x_premium_code_allocation",
    "checksum": "7d438d9efd558e9aa023dc9fa49f89d715fbe07c6a576ce7705be3e57e54e5d4"
  },
  {
    "name": "0015_card_editions",
    "checksum": "e16f4f316469af9eba39ff8e238e8027ed8396210eedaa1b1aeffce236ae48c5"
  },
  {
    "name": "0016_verified_share_codes",
    "checksum": "40f0968192c2025c398f9c73e7cdd5e78b52de2305d1d62cb2dd0d7d8501fcd2"
  },
  {
    "name": "0017_telegram_contact_reward",
    "checksum": "f7fb7833cc718c508e2c95bf728d705ce2e2612c0f567ee0bcd6620df9e29948"
  },
  {
    "name": "0018_ground_crew_intent",
    "checksum": "4ac508b60629b3ea65eed6d85d085f9994c8b4b4633f32192e595800708f0d6a"
  },
  {
    "name": "0019_seed_creator_codes",
    "checksum": "130a5df896ced0931c68613b749ec5e3e33987cbac155bd81f151fabdfa41dfa"
  },
  {
    "name": "0020_seed_community_code_groups",
    "checksum": "f1d3e9c883964f0cb4baac53ce44c8da2d32075756c2a435afc042af6a033030"
  },
  {
    "name": "0021_x_follow_share_reward",
    "checksum": "4b5a9f86b01144ab9c58843c848a7d02cb0f31c4dd4f3d41a18ba29818b98fd9"
  },
  {
    "name": "0022_crew_number_sequence",
    "checksum": "4676ba1104ebbd63adaeaeb39192faedfdf93aaee775dd520e048ebb93bfc27b"
  },
  {
    "name": "0023_card_images",
    "checksum": "ddfb2ef57f72503dd91cb9a35ded83a751f1432ed7a9ec90fd1e5351fdd96d2a"
  },
  {
    "name": "0024_x_verification_jobs",
    "checksum": "2b6d6e0d9f2b7451e1d83e6b53c03038bd70fd38cf6fc7beba49e4854a1d1645"
  },
  {
    "name": "0025_capacity_indexes",
    "checksum": "2245e1cbb160b12fa4730b6650135721f99e66d234b12253be8fa4b766d927e3"
  },
  {
    "name": "0026_x_verification_claim_index",
    "checksum": "ca92f0f019d8eee28571ca2e403ddddff13d27c82340b99aa255b8bdc309d6c5"
  },
  {
    "name": "0027_projection_watermark",
    "checksum": "2fb70ad88459587f8aed2b0c62eb2da3a5aa68c47dd5a3befc0d8ec0331dd81a"
  },
  {
    "name": "0028_follow_only_reward",
    "checksum": "0e5ce38f59fd0758cd461bd7c7c033c87dfba2598e4cc7dad7709703f035c47d"
  },
  {
    "name": "0029_season_member_capacity",
    "checksum": "56ee160c3f27d10ecf8a26a79372ae4a2ef3b230d6bc4448718101c76abc3d50"
  },
  {
    "name": "0030_runtime_roles",
    "checksum": "6955f952c1706032c681e06c07558cf0d23abcbe529f9930cad3717fb9b8b258"
  },
  {
    "name": "0031_launchpad_telemetry",
    "checksum": "aeac45905979d9165159f588ff5056d9b8347472302e41e5a2546b14415a6582"
  },
  {
    "name": "0032_launchpad_identity",
    "checksum": "a5d6e284d689e2f8d41a73dcd231d48d2d7d93f20ba700c93d4fa2413ffbae9b"
  },
  {
    "name": "0034_chain_read_views",
    "checksum": "7263e5664cf6d4d2c9478d4193e8484ad933e815cc55067a8fd1bac856ca0d5c"
  },
  {
    "name": "0035_operational_worker",
    "checksum": "92f783d272a929e31a42ad2e683e24c61289203b5beef0e8c90166e9dec67b30"
  },
  {
    "name": "0036_launchpad_social",
    "checksum": "21fa80c37ced8e180e0963d302604efad35e7eba130d1c85d8eca1a46c020986"
  },
  {
    "name": "0037_launchpad_outcome_attribution",
    "checksum": "7ac16d93307aec845d05ac3de863fb6491eb3840ec72e4cc5095f69a7c0f9343"
  },
  {
    "name": "0038_launch_migrations",
    "checksum": "9a915255fefc854ab82284066c900fc0bb3de2aec549ffe99248bafb39aeab41"
  },
  {
    "name": "0039_presale_embedded_wallets",
    "checksum": "3c054fb167e7ec2dfd18677a6e6b0fe707f0de2cc6a69dcbed2627eb18376f7f"
  },
  {
    "name": "0040_presale_worker",
    "checksum": "20277f14c878c8635d74cc355207d42da7e9453b41213a850f50a3661465898d"
  },
  {
    "name": "0041_presale_allowlists",
    "checksum": "62fc1cafcdbfa020af8e10a214e96c814e8f2689b106be432c15b5311863746c"
  },
  {
    "name": "0042_presale_sponsor_reservations",
    "checksum": "1a9cc129759e303b4c96199a3f7c8a6a5620c890c1122e9500ef5e36853be068"
  },
  {
    "name": "0043_presale_outcomes",
    "checksum": "887550ada3b33366fbcb1b193eebc60f804e0c92d46aedd461c8f306625b6893"
  },
  {
    "name": "0044_presale_bridge",
    "checksum": "a9d4ee7f6bc76307bc994d472608b83b8d83421c217047d167806f68b4cc5fd3"
  },
  {
    "name": "0045_presale_account_settings",
    "checksum": "b0a89a5032b4ac635cb59e80f67fdc933df646c5f7e03e7d1513fec38be66b19"
  },
  {
    "name": "0046_presale_receipt_images",
    "checksum": "1485489e8d0a14052dadb94736ef970cf1a7fccec34f6afc660436f751480180"
  },
  {
    "name": "0047_presale_allowlist_bindings",
    "checksum": "dc64595d62ea14bffbfbca30b069fedccc5b5a33d7bef696b6ae7480be5a032d"
  },
  {
    "name": "0048_presale_lifecycle",
    "checksum": "e39fa7d3fd3d3d444cc389d068b68f3626e9d57317cc4230739f4c0180cfc789"
  },
  {
    "name": "0049_presale_reward_ledgers",
    "checksum": "9c6c856f817ac9702395ca0e1228f3bdea588d01a7da9cce62c2b9b00c63b0ad"
  },
  {
    "name": "0050_presale_delivery",
    "checksum": "3823e5b63c3ed11373daf554339c14844be6f3cd4f7367c37901b27eb8d9dd49"
  },
  {
    "name": "0051_presale_bridge_observation",
    "checksum": "b9a2f6fe72d9f5b7928dd6d3339436ae6a0e64b6ab66263829077cbbcf530604"
  },
  {
    "name": "0052_presale_reward_rounds",
    "checksum": "b20772d7d9dde4ac86818a4804d27f0cb83aeac38080534b1213fe262fcaaa72"
  },
  {
    "name": "0054_social_schema",
    "checksum": "762a9bacb98fc3a407be98e5f003c9c56ee0dce95ed88061cf17bb9479bd7b1f"
  },
  {
    "name": "0055_social_feed_entries",
    "checksum": "cad8fe8c25fe582686d642e40f1d15c6b1627bf2fc7ab84a8bc0c6ecb1cadf18"
  },
  {
    "name": "0056_social_account_identities",
    "checksum": "3f348b8f3d5ed4425da1b8550e60147b983fb87401e122e50773d7fb2d4c1407"
  },
  {
    "name": "0057_social_feed_ui",
    "checksum": "41b5095095ae0b5db9d62a9a47be9830876049817c8e06a2a79e841b371af20d"
  },
  {
    "name": "0058_social_wallet_sign_in",
    "checksum": "a56914e58a26659f90043819da6bf09c5c92280ea756e2fa7d38f1a31e82107a"
  },
  {
    "name": "0059_social_settings",
    "checksum": "2b4efc0cfb822afaf65201e3e41ee8bebbb17835e91ad912e6a138f935bbe6cb"
  },
  {
    "name": "0062_social_profile_edit",
    "checksum": "41bbd61c153da90e33a1b670a3ffbe9586d568aa3b6b7de74b28771867fc1cb4"
  },
  {
    "name": "0064_social_notifications",
    "checksum": "3cb82513e29340490b2bd985eb8e9a121761d07060e46a0f3209fb5b1e025b97"
  },
  {
    "name": "0066_social_presale_theses",
    "checksum": "896a0cc1eefe4ea2c7e84c6b2aabb40fb33b41af69e9aeca228f4536115571f5"
  },
  {
    "name": "0068_social_presale_drafts",
    "checksum": "8d98405cc4c7ff762e0e2e8ae70396c71a902a3564c00695348774965a2e09f0"
  },
  {
    "name": "0072_social_watchlist_search",
    "checksum": "01f59de4214fa73250fc51d594b50bc8a25545e993b3dc1bc7e7dff2285d3ec4"
  },
  {
    "name": "0074_presale_sponsor_withdraw",
    "checksum": "0b4f030612ef777289f13dbed19758399038ec3a59927f8e71b28e211d199ed2"
  },
  {
    "name": "0075_social_coin_transfers",
    "checksum": "53183553462f02cbb7a9139e4af0dbdb83e4f33f36812f53c64769368c2e32ef"
  },
  {
    "name": "0079_social_whys_write",
    "checksum": "a0103058a9f7f791dbbf0d376e7a03a8776445d7936c46f277baa8bc312c404f"
  },
  {
    "name": "0080_social_why_reports_write",
    "checksum": "c347aa94f72c530e59daf1371c22aa62a0ede592e8feecb81ec7b1cc33f14538"
  },
  {
    "name": "0081_social_intents_resolve",
    "checksum": "1b74aec19ac6af8f4532c2dad04c67780514e77cf70970388e322c7f13b9b872"
  },
  {
    "name": "0084_social_transactions",
    "checksum": "26fec22925ddb58c53b6e7a87e772e180c5f9f105ee3ac321265e2da84ead4a9"
  },
  {
    "name": "0085_social_transactions_settle",
    "checksum": "3ba20f588a8638e1995c645496e98abba91b860ea906b6192840aa27c97dffdd"
  },
  {
    "name": "0088_social_sale_trust",
    "checksum": "3cd199815970ef38f98aa9a6dd3ec177f93d6ea62cfc0ca964c6053e54ca849d"
  },
  {
    "name": "0089_social_swap_intents",
    "checksum": "c3b549eb9ecc1665be244ada30c1bf0467d9238d1e64cadd84550753d3a43da2"
  },
  {
    "name": "0090_social_sale_metadata",
    "checksum": "3e7365ba7f16b5f40f3d587c8c45212708318003e2ed8947b4dd4c44aa7151e7"
  },
  {
    "name": "0091_social_presale_draft_details",
    "checksum": "f89bf4ab185fc41d9ee615c0c43dc1a1339ce2d8d7f33c6ca16df48ba86be369"
  },
  {
    "name": "0093_social_account_sound",
    "checksum": "047671d0dc5cd4dd39a05cd205dfa256ac3c4d3d6cdd77c4e8b53a335a48e06c"
  },
  {
    "name": "0096_social_transactions_open_claims",
    "checksum": "5c81821befdd1847b3f9f6a33a60e85299b68c59bdd33b43e17129eee3cd26ba"
  },
  {
    "name": "0097_social_portfolio_snapshots",
    "checksum": "ca7b9e60e8f334b4c5be7f25a75645ca00471b92ea9b06a72dc885b4e995d180"
  },
  {
    "name": "0098_social_whys_presale_bigint",
    "checksum": "98664f9ad9c085a7f963b92d59af9b0439b511a90afe946f5aeed3b97d58604f"
  },
  {
    "name": "0099_social_account_sound_unset",
    "checksum": "a36c2b1f83c4af5450e4937723a4959e068d07150d302c513f33e453c9f6fef6"
  },
  {
    "name": "0100_social_bridge_withdrawals",
    "checksum": "0051abe462594613dcc67632d3b7196f013022a23ff03e4dcb36bc41964d8eb0"
  },
  {
    "name": "0101_presale_reward_relays",
    "checksum": "f7e884bcc28db3b501923332ab0856d8509cb8a4484466219f38149c6b2e901e"
  },
  {
    "name": "0102_sponsored_trades_and_open_deposits",
    "checksum": "380c8d4b394196796db3ac30e86fcaf9998284cc93c9378afa94b39a25cbee06"
  },
  {
    "name": "0103_sponsor_address_balance",
    "checksum": "ffe4d428357bcd2607c1b002f81e299d3d66377e0094c988771a259295229617"
  },
  {
    "name": "0104_presale_lifecycle_aftermath",
    "checksum": "5f76dc7ebd74bdfefc84f31c4216a4794dc298bd6d5abc0fd027df02590cf4f8"
  },
  {
    "name": "0105_settlement_outbox",
    "checksum": "d27ed1809bcdf7b9c39d45e4843573266c6de41e733a15d93f852bb50068942b"
  },
  {
    "name": "0106_daily_reward_plans",
    "checksum": "b1d6fa5ac96349fa4fa5c1f13ce550465498222f9625a87b29737a491619f2c5"
  },
  {
    "name": "0107_outbox_input_reservations",
    "checksum": "b355b05c5b4703e7c9306cd9459dcff16d22288cc4808c582194657cfa6035cc"
  },
  {
    "name": "0108_social_shared_evidence",
    "checksum": "f2e5850c63b2c41be2b5b9f13dd0626568756a83691d816a6684c8fe43389679"
  },
  {
    "name": "0109_presale_sponsor_creation",
    "checksum": "2b0c904612b2f6e3a07fbc306744d237c973c7f28883e9b51cf1b3b75b8402c7"
  },
  {
    "name": "0110_social_presale_creation_discovery",
    "checksum": "c9c0e5538edffc3a22a9fc10072c7d21ba98b49ab8060116fc091e4c5dc98452"
  },
  {
    "name": "0111_social_presale_pins",
    "checksum": "90fd9036acd9a29e498bba0099291201b1dcafdca2868a9e0f7f54bbd495ce29"
  },
  {
    "name": "0112_wallet_balance_tracking",
    "checksum": "ff36b00fe473c0ef75a36734341c80d4dd422759c9fc284b5ab90784993b0233"
  },
  {
    "name": "0113_social_callsign_history",
    "checksum": "51a7012ad0fa1d1a75a693a41b0e62ecc30e605e523cc38269f40e28dafeaf62"
  },
  {
    "name": "0114_social_connection_pages",
    "checksum": "90981cea166b122b324627889b1316e5a5cb8a5b2bac02e1b52cc1f7f9454877"
  },
  {
    "name": "0115_social_connection_search",
    "checksum": "3ca14025796592835fdd3db98c4bb0876a961698a72e85e585211fff7881ba33"
  },
  {
    "name": "0115_trade_balance_failure",
    "checksum": "a8211fcac90e5bb75588f6c85ab195464091948f299fd1c93a87f4d73c8cab4b"
  },
  {
    "name": "0116_social_account_referrals",
    "checksum": "a1da8a9d7bc2d53dea32d23795915e0a532f2f25845840ef5626bc1cca5d57a7"
  },
  {
    "name": "0117_standalone_vault_rewards",
    "checksum": "0fb77942f468a32d221b1f6a98542fa1ddb1db47b692c5f135abe5779ae1a401"
  },
  {
    "name": "0118_utility_vesting",
    "checksum": "df526b0d109c9f470271cea4757c32e0120acd0fedb4d2d40aa13ee529ca994d"
  },
  {
    "name": "0119_creator_earnings",
    "checksum": "aff1fd80e91db570cb3b6e8183f37752f440cb8b3540e892f5fe7507bee6cb21"
  },
  {
    "name": "0120_vesting_sponsorship",
    "checksum": "a8d87689ffa7e04c3e78208037a8ff974e80a7c2ee7b37f1d13487c101cd1817"
  },
  {
    "name": "0121_reward_blacklists",
    "checksum": "30c5319aed7e247d8908d89ee96350c43571ae74938ddb81d2fdbde863edf8c5"
  },
  {
    "name": "0122_social_blast_workspace",
    "checksum": "13064adb51bdeffc395a2642f4a64e86d0f909e82eb5b371545ae84192fb3931"
  },
  {
    "name": "0123_allowlist_source",
    "checksum": "6c63640765dfdaf0d429bab5abbaeea798aab4f41f97deba05eb663f0147256d"
  },
  {
    "name": "0124_partner_api_keys",
    "checksum": "9282d7141e11c430a9289ddcb844213d9b5e7f6d650c05e7c35ff22e0e14a393"
  },
  {
    "name": "0124_social_blast_confirmation",
    "checksum": "f0d3ffd2fd10c51792b57c27f7155c7a4db6fc2e6194eb4a1304e678181b9b47"
  },
  {
    "name": "0125_frontend_swap_receipts",
    "checksum": "847eb86735a47172c63299d29cf7ce9a21881237d1da095f3019fff1208ac9c1"
  },
  {
    "name": "0126_social_competitions",
    "checksum": "5fb64dc4315560ab647f4c2e07b40166651fb05d33e8d08cfc6a224f39a35361"
  }
];

async function readLedger(client) {
  const { rows: [gate] } = await client.query(`
    WITH ledger AS (
      SELECT c.oid, c.relnamespace, c.relkind, c.relrowsecurity
      FROM pg_catalog.pg_class c
      WHERE c.oid = to_regclass('public.mission_control_schema_migrations')
    )
    SELECT EXISTS (
      SELECT 1 FROM ledger l
      WHERE l.relkind IN ('r', 'p') AND NOT l.relrowsecurity
        AND to_regclass('mission_control_schema_migrations') = l.oid
        AND has_schema_privilege(current_user, l.relnamespace, 'USAGE')
        AND has_table_privilege(current_user, l.oid, 'SELECT')
        AND NOT EXISTS (
          SELECT 1 FROM (VALUES ('name'), ('checksum')) AS expected(col)
          LEFT JOIN pg_catalog.pg_attribute a
            ON a.attrelid = l.oid AND a.attname = expected.col
              AND a.attnum > 0 AND NOT a.attisdropped
          WHERE a.attnum IS NULL OR format_type(a.atttypid, a.atttypmod) <> 'text'
            OR NOT a.attnotnull
        )
    ) AS readable
  `);
  if (gate?.readable !== true) return null;
  const { rows } = await client.query(
    'SELECT name, checksum FROM public.mission_control_schema_migrations WHERE name = ANY($1::text[]) ORDER BY name',
    [expectedMigrations.map(({ name }) => name)],
  );
  return rows;
}
let ledgerRows = null;
let runtimeLedgerReadable = false;
let client;
let began = false;
let ok = false;
let metadata = {};
try {
  if (!process.env.DATABASE_URL) throw new Error();
  client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    query_timeout: 7000,
  });
  client.on('error', () => { ok = false; });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  began = true;
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL lock_timeout = '1s'");
  const { rows: [r] } = await client.query(`
    WITH expected(rel, col, typ) AS (VALUES
      ('social_accounts', 'account_id', 'uuid'),
      ('social_accounts', 'blast_mode_confirm_actions', 'boolean'),
      ('social_blast_workspaces', 'account_id', 'uuid'),
      ('social_blast_workspaces', 'schema_version', 'integer'),
      ('social_blast_workspaces', 'workspace', 'jsonb'),
      ('social_blast_workspaces', 'revision', 'bigint'),
      ('social_blast_workspaces', 'saved_at_ms', 'bigint'),
      ('social_blast_workspace_writers', 'account_id', 'uuid'),
      ('social_blast_workspace_writers', 'writer_id', 'text'),
      ('social_blast_workspace_writers', 'sequence', 'bigint'),
      ('social_blast_workspace_writers', 'payload_fingerprint', 'text'),
      ('social_blast_workspace_writers', 'accepted_revision', 'bigint'),
      ('social_blast_workspace_writers', 'saved_at_ms', 'bigint')
    ), rels AS (SELECT DISTINCT rel FROM expected), resolved AS (
      SELECT r.rel, c.oid, c.relnamespace, c.relkind, c.relrowsecurity
      FROM rels r LEFT JOIN pg_catalog.pg_class c
        ON c.oid = to_regclass('public.' || r.rel)
    )
    SELECT
      EXISTS (
        SELECT 1 FROM resolved
        WHERE rel = 'social_blast_workspaces' AND oid IS NULL
      ) AS workspace_name_absent,
      EXISTS (
        SELECT 1 FROM resolved
        WHERE rel = 'social_blast_workspace_writers' AND oid IS NULL
      ) AS writers_name_absent,
      EXISTS (
        SELECT 1 FROM resolved
        WHERE rel = 'social_blast_workspaces' AND oid IS NOT NULL AND relkind IN ('r', 'p')
      ) AS workspace_table_exists,
      EXISTS (
        SELECT 1 FROM resolved
        WHERE rel = 'social_blast_workspace_writers' AND oid IS NOT NULL AND relkind IN ('r', 'p')
      ) AS writers_table_exists,
      EXISTS (
        SELECT 1 FROM resolved
        WHERE rel = 'social_accounts' AND oid IS NOT NULL AND relkind IN ('r', 'p')
      ) AS public_accounts_table_exists,
      EXISTS (
        SELECT 1 FROM resolved
        WHERE rel = 'social_accounts' AND oid IS NOT NULL AND relkind IN ('r', 'p')
          AND to_regclass('social_accounts') = oid
      ) AS accounts_public_resolution_ok,
      EXISTS (
        SELECT 1 FROM resolved r
        JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid
        WHERE r.rel = 'social_accounts' AND r.relkind IN ('r', 'p')
          AND a.attname = 'blast_mode_confirm_actions' AND a.attnum > 0 AND NOT a.attisdropped
      ) AS confirmation_column_exists,
      NOT EXISTS (
        SELECT 1 FROM resolved
        WHERE oid IS NULL OR relkind NOT IN ('r', 'p') OR relrowsecurity
          OR to_regclass(rel) IS DISTINCT FROM oid
          OR NOT has_schema_privilege(current_user, relnamespace, 'USAGE')
      ) AS relations_ok,
      NOT EXISTS (
        SELECT 1 FROM expected e
        LEFT JOIN resolved r ON r.rel = e.rel
        LEFT JOIN pg_catalog.pg_attribute a
          ON a.attrelid = r.oid AND a.attname = e.col AND a.attnum > 0 AND NOT a.attisdropped
        WHERE a.attnum IS NULL OR format_type(a.atttypid, a.atttypmod) <> e.typ OR NOT a.attnotnull
      ) AS columns_ok,
      EXISTS (
        SELECT 1 FROM resolved r
        JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid
        JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE r.rel = 'social_accounts' AND a.attname = 'blast_mode_confirm_actions'
          AND pg_get_expr(d.adbin, d.adrelid) = 'false'
      ) AS confirmation_default_ok,
      NOT EXISTS (
        SELECT 1 FROM resolved r
        WHERE r.rel IN ('social_blast_workspaces', 'social_blast_workspace_writers')
          AND (r.oid IS NULL OR NOT has_table_privilege(current_user, r.oid, 'SELECT')
            OR NOT has_table_privilege(current_user, r.oid, 'INSERT')
            OR NOT has_table_privilege(current_user, r.oid, 'UPDATE'))
      ) AS workspace_privileges_ok,
      EXISTS (
        SELECT 1 FROM resolved r
        JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid
        WHERE r.rel = 'social_accounts' AND a.attname = 'blast_mode_confirm_actions'
          AND a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege(current_user, r.oid, a.attnum, 'SELECT')
          AND has_column_privilege(current_user, r.oid, a.attnum, 'UPDATE')
      ) AS confirmation_privileges_ok
  `);
  // Diagnostic absence booleans are not readiness requirements.
  ok = ['relations_ok', 'columns_ok', 'confirmation_default_ok',
    'workspace_privileges_ok', 'confirmation_privileges_ok'].every(key => r[key] === true);
  metadata = r;
  ledgerRows = await readLedger(client);
  runtimeLedgerReadable = ledgerRows !== null;
} catch {
  ok = false;
} finally {
  if (began) await client.query('ROLLBACK').catch(() => { ok = false; });
  if (client) await client.end().catch(() => { ok = false; });
}
// Only an already configured migration credential may be used; no fallback
// to another environment or database and no permission changes are attempted.
const migrationCredentialConfigured = Boolean(process.env.DATABASE_MIGRATION_URL?.trim());
let migrationTargetMatchesRuntime = false;
let migrationLedgerAttempted = false;
let migrationLedgerReadable = false;
if (ledgerRows === null && migrationCredentialConfigured && process.env.DATABASE_URL?.trim()) {
  let migrationClient;
  let migrationBegan = false;
  try {
    const { migrationDatabaseUrl } = await import('../packages/core/src/modules/database/topology.ts');
    const connectionString = migrationDatabaseUrl();
    migrationTargetMatchesRuntime = true;
    migrationClient = new Client({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 7000 });
    migrationClient.on('error', () => { ok = false; });
    migrationLedgerAttempted = true;
    await migrationClient.connect();
    await migrationClient.query('BEGIN READ ONLY');
    migrationBegan = true;
    await migrationClient.query("SET LOCAL statement_timeout = '5s'");
    await migrationClient.query("SET LOCAL lock_timeout = '1s'");
    ledgerRows = await readLedger(migrationClient);
    migrationLedgerReadable = ledgerRows !== null;
  } catch {
    // Missing, denied, mismatched or failed metadata reads remain UNKNOWN.
    ledgerRows = null;
  } finally {
    if (migrationBegan) await migrationClient.query('ROLLBACK').catch(() => { ledgerRows = null; ok = false; });
    if (migrationClient) await migrationClient.end().catch(() => { ledgerRows = null; ok = false; });
  }
}
const ledgerKnown = ledgerRows !== null;
const ledgerSummary = {};
if (ledgerKnown) {
  const applied = new Map(ledgerRows.map(({ name, checksum }) => [name, checksum]));
  const pending = expectedMigrations.filter(({ name }) => !applied.has(name));
  const mismatched = expectedMigrations.filter(({ name, checksum }) => applied.has(name) && applied.get(name) !== checksum);
  ledgerSummary.applied_expected_count = applied.size;
  ledgerSummary.pending_count = pending.length;
  ledgerSummary.pending_filenames = pending.map(({ name }) => `${name}.up.sql`);
  ledgerSummary.checksum_mismatch_count = mismatched.length;
  ledgerSummary.checksum_mismatch_filenames = mismatched.map(({ name }) => `${name}.up.sql`);
}
ok = ok && ledgerKnown && ledgerSummary.pending_count === 0 && ledgerSummary.checksum_mismatch_count === 0;
console.log(JSON.stringify({
  ok, ...metadata,
  runtime_ledger_readable: runtimeLedgerReadable,
  migration_credential_configured: migrationCredentialConfigured,
  migration_target_matches_runtime: migrationTargetMatchesRuntime,
  migration_ledger_attempted: migrationLedgerAttempted,
  migration_ledger_readable: migrationLedgerReadable,
  ledger_known: ledgerKnown,
  expected_migration_count: expectedMigrations.length,
  ...ledgerSummary,
}));
process.exitCode = ok ? 0 : 1;
