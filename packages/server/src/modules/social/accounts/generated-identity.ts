import { randomInt } from "node:crypto";

const ADJECTIVES = ["Cosmic", "Lunar", "Solar", "Neon", "Swift", "Lucky", "Nova", "Bold"];
const ANIMALS = ["Otter", "Fox", "Panda", "Falcon", "Tiger", "Gecko", "Raven", "Koala"];

export function generateAccountIdentity(): Readonly<{ callsign: string; displayName: string }> {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const animal = ANIMALS[randomInt(ANIMALS.length)];
  const suffix = randomInt(10_000).toString().padStart(4, "0");
  return { callsign: `${adjective}_${animal}_${suffix}`.toLowerCase(), displayName: `${adjective} ${animal}` };
}
