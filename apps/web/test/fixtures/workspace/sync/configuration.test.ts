import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "pg-connection-string";
import { syncFixtureConfiguration } from "./configuration.ts";

test("T-018: account fixture accepts only its allocated isolated loopback database", () => {
  const environment = {
    T018_CONFIG_DIR: "/private/t018",
    MISSION_CONTROL_TEST_DATABASE_URL:
      "postgresql://postgres:test@127.0.0.1:35307/mission_control_test",
  };
  assert.equal(
    syncFixtureConfiguration(environment).origin,
    "http://127.0.0.1:42970",
  );
  for (const url of [
    "postgresql://postgres:test@127.0.0.1:35275/mission_control_test",
    "postgresql://postgres:test@remote:35307/mission_control_test",
    "postgresql://postgres:test@127.0.0.1:35307/live",
  ]) {
    assert.throws(() =>
      syncFixtureConfiguration({
        ...environment,
        MISSION_CONTROL_TEST_DATABASE_URL: url,
      }),
    );
  }
});

test("T-018: fixture rejects connection query overrides before PostgreSQL can use them", () => {
  for (const lane of [
    { T018_CONFIG_DIR: "/private/t018", port: "35307" },
    { T013_CONFIG_DIR: "/private/t013", port: "35275" },
  ]) {
    for (const [query, host, port] of [
      ["host=remote.invalid", "remote.invalid", lane.port],
      ["port=5432", "127.0.0.1", "5432"],
      ["%68ost=remote.invalid", "remote.invalid", lane.port],
      ["%70ort=5432", "127.0.0.1", "5432"],
    ]) {
      const url = `postgresql://postgres:test@127.0.0.1:${lane.port}/mission_control_test?${query}`;
      const parsed = parse(url);
      assert.deepEqual(
        { host: parsed.host, port: parsed.port },
        { host, port },
      );
      assert.throws(
        () =>
          syncFixtureConfiguration({
            ...lane,
            MISSION_CONTROL_TEST_DATABASE_URL: url,
          }),
        /Use the assigned isolated workspace fixture/,
        query,
      );
    }
  }
});

test("T-018: fixture rejects other input connection parameters", () => {
  for (const query of [
    "options=-c%20role%3Dblast_web",
    "dbname=other_database",
    "sslmode=disable",
    "application_name=fixture",
  ]) {
    assert.throws(
      () =>
        syncFixtureConfiguration({
          T018_CONFIG_DIR: "/private/t018",
          MISSION_CONTROL_TEST_DATABASE_URL: `postgresql://postgres:test@127.0.0.1:35307/mission_control_test?${query}`,
        }),
      /Use the assigned isolated workspace fixture/,
      query,
    );
  }
});

test("T-018: fixture preserves both allocated lanes and trusted runtime role options", () => {
  for (const lane of [
    {
      environment: { T018_CONFIG_DIR: "/private/t018" },
      directory: "/private/t018",
      port: "35307",
      origin: "http://127.0.0.1:42970",
    },
    {
      environment: { T013_CONFIG_DIR: "/private/t013" },
      directory: "/private/t013",
      port: "35275",
      origin: "http://127.0.0.1:42928",
    },
  ]) {
    const url = `postgresql://postgres:test@127.0.0.1:${lane.port}/mission_control_test`;
    const configuration = syncFixtureConfiguration({
      ...lane.environment,
      MISSION_CONTROL_TEST_DATABASE_URL: url,
    });
    assert.deepEqual(configuration, {
      directory: lane.directory,
      url,
      origin: lane.origin,
    });
    const runtime = new URL(configuration.url);
    runtime.searchParams.set("options", "-c role=blast_web");
    const parsed = parse(runtime.toString());
    assert.deepEqual(
      {
        host: parsed.host,
        port: parsed.port,
        database: parsed.database,
        options: parsed.options,
      },
      {
        host: "127.0.0.1",
        port: lane.port,
        database: "mission_control_test",
        options: "-c role=blast_web",
      },
    );
  }
});
