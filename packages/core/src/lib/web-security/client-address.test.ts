import assert from "node:assert/strict";
import test from "node:test";
import { isIP } from "node:net";
import { attestClientAddress, rateLimitAddress } from "./client-address.ts";
import { DEFAULT_RATE_POLICIES, rateLimitSubjectKey } from "./rate-limits.ts";
import { testClient } from "../../../test/fixtures/lib/web-security/client-address.ts";

test("an attested client carries the canonical address and its rate-limit key", () => {
  for (const [input, address, rateKey] of [
    ["203.0.113.7", "203.0.113.7", "203.0.113.7"],
    ["::ffff:203.0.113.9", "203.0.113.9", "203.0.113.9"],
    ["::192.0.2.1", "192.0.2.1", "192.0.2.1"],
    ["2001:DB8::1", "2001:db8::1", "2001:db8:0:0::/64"],
    ["2001:db8:1:2::1", "2001:db8:1:2::1", "2001:db8:1:2::/64"],
    [
      "2001:db8:1:2:ffff:eeee:dddd:cccc",
      "2001:db8:1:2:ffff:eeee:dddd:cccc",
      "2001:db8:1:2::/64",
    ],
    ["2001:db8:1:3::1", "2001:db8:1:3::1", "2001:db8:1:3::/64"],
  ] as const) {
    const client = attestClientAddress(input);
    assert.deepEqual({ ...client }, { address, rateKey }, input);
    assert.ok(Object.isFrozen(client), input);
  }
});

test("only a single IP address is attested", () => {
  for (const input of [
    null,
    "",
    "unavailable",
    "fe80::1%eth0",
    "203.0.113.7, 198.51.100.1",
    "203.0.113.7:443",
    "[2001:db8::1]",
    " 203.0.113.7 ",
  ]) {
    assert.equal(attestClientAddress(input), null, String(input));
  }
});

test("attested clients keep the existing IP and wallet rate-limit identities", () => {
  const ipv4 = testClient("203.0.113.7");
  const ipv6 = testClient("2001:db8:1:2::1");
  const sameSubnet = testClient("2001:db8:1:2:ffff:eeee:dddd:cccc");
  const otherSubnet = testClient("2001:db8:1:3::1");
  const mapped = testClient("::ffff:203.0.113.9");
  const compatible = testClient("::192.0.2.1");

  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet_ip, { ip: ipv4.rateKey }),
    "ip:203.0.113.7",
  );
  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet_ip, { ip: ipv6.rateKey }),
    "ip:2001:db8:1:2::/64",
  );
  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet_ip, {
      ip: sameSubnet.rateKey,
    }),
    "ip:2001:db8:1:2::/64",
  );
  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet_ip, {
      ip: otherSubnet.rateKey,
    }),
    "ip:2001:db8:1:3::/64",
  );
  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet_ip, {
      ip: mapped.rateKey,
    }),
    "ip:203.0.113.9",
  );
  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet_ip, {
      ip: compatible.rateKey,
    }),
    "ip:192.0.2.1",
  );

  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet, {
      ip: ipv4.rateKey,
      address: "0xAbC",
    }),
    "ip:203.0.113.7\0address:0xabc",
  );
  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet, {
      ip: ipv6.rateKey,
      address: "0xAbC",
    }),
    "ip:2001:db8:1:2::/64\0address:0xabc",
  );
  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet, {
      ip: sameSubnet.rateKey,
      address: "0xAbC",
    }),
    "ip:2001:db8:1:2::/64\0address:0xabc",
  );
  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet, {
      ip: otherSubnet.rateKey,
      address: "0xAbC",
    }),
    "ip:2001:db8:1:3::/64\0address:0xabc",
  );
  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet, {
      ip: mapped.rateKey,
      address: "0xAbC",
    }),
    "ip:203.0.113.9\0address:0xabc",
  );
  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet, {
      ip: compatible.rateKey,
      address: "0xAbC",
    }),
    "ip:192.0.2.1\0address:0xabc",
  );
});

test("rate-limit subjects preserve IPv6 /64, mapped IPv4, and zone equivalence", () => {
  const subjects: Record<string, string[]> = {
    "2001:db8:1:2::/64": [
      "2001:db8:1:2::1",
      "2001:0DB8:0001:0002:ffff:eeee:dddd:cccc",
      "2001:db8:1:2:3:4:192.0.2.1",
      "2001:db8:1:2::192.0.2.1",
      "2001:db8:1:2::1%eth-0",
      "2001:db8:1:2::1%en0.1",
    ],
    "0:0:0:0::/64": [
      "::",
      "::1",
      "::c000:201",
      "::0:192.0.2.1",
      "0:0:0:0:0:0:192.0.2.1",
      "::ffff:0:192.0.2.1",
    ],
    "192.0.2.1": [
      "::192.0.2.1",
      "::192.0.2.1%eth-0",
      "192.0.2.1",
      "::ffff:192.0.2.1",
      "::FFFF:c000:201",
      "0:0:0:0:0:ffff:c000:201",
      "0:0:0:0:0:FFFF:192.0.2.1",
      "::ffff:192.0.2.1%en0.1",
    ],
    "fe80:0:0:0::/64": ["fe80::1%eth0", "fe80::1%eth-0", "fe80::1%en0.1"],
    "64:ff9b:0:0::/64": ["64:ff9b::192.0.2.1", "64:ff9b::c000:201"],
    "ffff:ffff:ffff:ffff::/64": ["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  };
  for (const [subject, addresses] of Object.entries(subjects)) {
    for (const address of addresses) assert.equal(rateLimitAddress(address), subject, address);
  }
  assert.notEqual(rateLimitAddress("2001:db8:1:3::1"), "2001:db8:1:2::/64");
});

test("every valid zero-compression position parses without changing the rate-limit subject", () => {
  const cases: [string[], string][] = [
    [["0", "0", "0", "0", "0", "0", "0", "0"], "0:0:0:0::/64"],
    [["0", "0", "0", "0", "0", "ffff", "c000", "201"], "192.0.2.1"],
    [["0", "0", "0", "0", "0", "0", "c000", "201"], "0:0:0:0::/64"],
    [["2001", "db8", "0", "0", "3", "0", "0", "4"], "2001:db8:0:0::/64"],
  ];
  for (const [groups, subject] of cases) {
    const addresses = [groups.join(":")];
    for (let start = 0; start < groups.length; start++) {
      for (let end = start + 1; end <= groups.length && groups[end - 1] === "0"; end++) {
        addresses.push(`${groups.slice(0, start).join(":")}::${groups.slice(end).join(":")}`);
      }
    }
    for (const address of addresses) {
      for (const zone of ["", "%eth0", "%eth-0", "%en0.1"]) {
        const input = `${address}${zone}`;
        assert.equal(isIP(input), 6, input);
        assert.equal(rateLimitAddress(input), subject, input);
      }
    }
  }
});

test("rate-limit addresses retain native strict validation and the 64-character bound", () => {
  for (const address of [
    "", "not-an-ip", "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "127.000.0.1", "999.1.1.1",
    "2001::db8::1", "2001:db8:1:2:3:4:5:6:7", "2001:db8:1:2:3:4:5", "12345::", "::ffff:192.0.2.256",
    "::ffff:192.000.2.1", "[::1]", "::1/64", "fe80::1%", "fe80::1%eth_0", "203.0.113.9|0xabc",
  ]) {
    assert.equal(isIP(address), 0, address);
    assert.equal(rateLimitAddress(address), null, address);
  }
  const bounded = `fe80::1%${"a".repeat(56)}`;
  assert.equal(bounded.length, 64);
  assert.equal(rateLimitAddress(bounded), "fe80:0:0:0::/64");
  assert.equal(isIP(`${bounded}a`), 6);
  assert.equal(rateLimitAddress(`${bounded}a`), null);
});
