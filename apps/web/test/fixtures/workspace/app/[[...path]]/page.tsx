import type { Metadata } from "next";
import { WorkspaceFixture } from "../../WorkspaceFixture";
export const metadata: Metadata = { title: "Workspace fixture" };
export default function Page() {
  return <WorkspaceFixture />;
}
