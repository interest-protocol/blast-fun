import { SOCIAL_PAGE_PATHS } from "@blast/core/lib/social-page-routes.ts";
import { redirect } from "next/navigation";
export default function VestingOverviewPage() { redirect(SOCIAL_PAGE_PATHS.portfolioClaims); }
