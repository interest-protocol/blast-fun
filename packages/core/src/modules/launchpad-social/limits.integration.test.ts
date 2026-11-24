import assert from "node:assert/strict";
import test from "node:test";

import { freshTestDatabase } from "../../../test/fixtures/modules/database/template.ts";
import { createPool } from "../database/pool.ts";
import { DATABASE_CEILINGS } from "./limits.ts";

// Fails if a migrated database accepts text or link data beyond its safety ceilings.
test("migrated launchpad social tables accept the safety ceilings and reject values outside them", async () => {
  const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
  assert.ok(databaseUrl, "a disposable loopback test database is required");
  const target = new URL(databaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(target.protocol));
  assert.equal(
    target.search,
    "",
    "the loopback test URL cannot contain query overrides",
  );
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  const database = await freshTestDatabase();
  const pool = createPool(database.url, { max: 1 });
  try {
    assert.deepEqual(DATABASE_CEILINGS, {
      bodyCharacters: 10_000,
      disclosureCharacters: 10_000,
      evidenceLinks: 32,
      evidenceCharacters: 65_536,
      searchTextCharacters: 40_000,
    });
    await pool.query(`
      INSERT INTO mission_control_launchpad_social_authors
        (author_identity_id, author_method, author_subject_key)
      VALUES ('00000000-0000-4000-8000-000000000001', 'privy', repeat('a', 64))
    `);
    const links = [
      "https://" + "a".repeat(65_218),
      ...Array<string>(31).fill("https://b"),
    ];
    const accepted = await pool.query(
      `
      INSERT INTO mission_control_launchpad_theses
        (record_id, thesis_id, launch_id, kind, stance, author_identity_id,
         body, evidence_links, disclosure_text, verification, network,
         deployment_fingerprint, launch_checkpoint)
      VALUES ('00000000-0000-4000-8000-000000000002',
              '00000000-0000-4000-8000-000000000002',
              '0x' || repeat('b', 64), 'community_thesis', 'neutral',
              '00000000-0000-4000-8000-000000000001',
              $1, $2, $3, 'not_requested', 'mainnet', repeat('c', 64), 1)
      RETURNING char_length(body) AS body_chars,
                char_length(disclosure_text) AS disclosure_chars,
                cardinality(evidence_links) AS link_count,
                char_length(array_to_string(evidence_links, ' ')) AS link_chars
    `,
      ["🙂".repeat(10_000), links, "d".repeat(10_000)],
    );
    assert.deepEqual(accepted.rows, [
      {
        body_chars: 10_000,
        disclosure_chars: 10_000,
        link_count: 32,
        link_chars: 65_536,
      },
    ]);

    await assert.rejects(
      pool.query("UPDATE mission_control_launchpad_theses SET body = $1", [
        "b".repeat(10_001),
      ]),
      {
        code: "23514",
        constraint: "mission_control_launchpad_theses_body_check",
      },
    );
    await assert.rejects(
      pool.query("UPDATE mission_control_launchpad_theses SET body = ''"),
      {
        code: "23514",
        constraint: "mission_control_launchpad_theses_body_check",
      },
    );
    await assert.rejects(
      pool.query(
        "UPDATE mission_control_launchpad_theses SET disclosure_text = $1",
        ["d".repeat(10_001)],
      ),
      {
        code: "23514",
        constraint: "mission_control_launchpad_theses_disclosure_text_check",
      },
    );
    await assert.rejects(
      pool.query(
        "UPDATE mission_control_launchpad_theses SET disclosure_text = ''",
      ),
      {
        code: "23514",
        constraint: "mission_control_launchpad_theses_disclosure_text_check",
      },
    );
    await assert.rejects(
      pool.query(
        "UPDATE mission_control_launchpad_theses SET evidence_links = $1",
        [Array<string>(33).fill("https://b")],
      ),
      {
        code: "23514",
        constraint: "mission_control_launchpad_theses_evidence_links_check",
      },
    );
    await assert.rejects(
      pool.query(
        "UPDATE mission_control_launchpad_theses SET evidence_links = $1",
        [
          [
            "https://" + "a".repeat(65_219),
            ...Array<string>(31).fill("https://b"),
          ],
        ],
      ),
      {
        code: "23514",
        constraint: "mission_control_launchpad_theses_evidence_links_check",
      },
    );

    const searchText = "s ".repeat(19_999) + "ss";
    const search = await pool.query(
      `
      INSERT INTO mission_control_launchpad_search_documents (record_id, launch_id, search_text)
      SELECT record_id, launch_id, $1 FROM mission_control_launchpad_theses
      RETURNING char_length(search_text) AS search_chars
    `,
      [searchText],
    );
    assert.deepEqual(search.rows, [{ search_chars: 40_000 }]);
    await assert.rejects(
      pool.query(
        "UPDATE mission_control_launchpad_search_documents SET search_text = $1",
        [searchText + "s"],
      ),
      {
        code: "23514",
        constraint:
          "mission_control_launchpad_search_documents_search_text_check",
      },
    );
    await assert.rejects(
      pool.query(
        "UPDATE mission_control_launchpad_search_documents SET search_text = ''",
      ),
      {
        code: "23514",
        constraint:
          "mission_control_launchpad_search_documents_search_text_check",
      },
    );
  } finally {
    await pool.end();
    await database.drop();
  }
});
