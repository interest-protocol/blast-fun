import { permanentRedirect } from "next/navigation";
import { SOCIAL_PAGE_PATHS } from "@blast/core/lib/social-page-routes.ts";
/** Rewards is part of Claims now (2026-11-14): old links land there. */
export default function RewardsPage() { permanentRedirect(SOCIAL_PAGE_PATHS.portfolioClaims); }
