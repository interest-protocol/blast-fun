import { z } from "zod";
export const CARD_EDITIONS = [
  "quasar", "cosmic", "prism", "pearl", "aurora", "silver", "bronze", "lunar",
  "recruit", "manifest", "countdown", "8-bit", "sui", "blast-launch-day",
] as const;
export type CardEdition = (typeof CARD_EDITIONS)[number];

export const CARD_EDITION_NAMES: Record<CardEdition, string> = {
  quasar: "Quasar", cosmic: "Cosmic", prism: "Prism", pearl: "Pearl",
  aurora: "Aurora", silver: "Silver", bronze: "Bronze", lunar: "Lunar",
  recruit: "Recruit", manifest: "Manifest · 1 of 1", sui: "Sui · 1 of 1",
  countdown: "Countdown · 1 of 1", "8-bit": "8-Bit · 1 of 1",
  "blast-launch-day": "Blast Launch Day · 1 of 1",
};

/** Only the crew number allocated by the server decides the edition. */
export function cardEditionForCrew(crew: number): CardEdition {
  if (!z.number().int().min(1).max(999999).safeParse(crew).success) {
    throw new RangeError("crew must be an integer from 1 through 999999.");
  }
  if (crew === 69) return "manifest";
  if (crew === 123) return "countdown";
  if (crew === 256) return "8-bit";
  if (crew === 503) return "sui";
  if (crew === 727) return "blast-launch-day";
  if (crew <= 25) return "quasar";
  if (crew <= 50) return "cosmic";
  if (crew <= 100) return "prism";
  if (crew <= 150) return "pearl";
  if (crew <= 200) return "aurora";
  if (crew <= 300) return "silver";
  if (crew <= 500) return "bronze";
  if (crew <= 1000) return "lunar";
  return "recruit";
}
