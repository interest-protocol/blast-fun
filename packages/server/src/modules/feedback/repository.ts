import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { autocommitRead, autocommitWrite } from "@blast/core/modules/database/transaction.ts";
import type { FeedbackKind } from "@blast/core/web/contracts/feedback.ts";

type Submission = Readonly<{ id: string; kind: FeedbackKind; message: string }>;
type FeedbackRow = Submission & Readonly<{ createdAt: Date; reviewed: boolean }>;
const PAGE_SIZE = 25;

export async function saveFeedback({ id, kind, message }: Submission) {
  await autocommitWrite(
    primaryPool(), "social", "social_product_feedback",
    `INSERT INTO social_product_feedback (id, kind, message)
     VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [id, kind, message],
  );
}

export async function listFeedback(kind: FeedbackKind | null, before: string | null) {
  const { rows } = await autocommitRead<FeedbackRow>(
    primaryPool(), "social",
    `SELECT id, kind, message, created_at AS "createdAt", reviewed_at IS NOT NULL AS reviewed
     FROM social_product_feedback
     WHERE ($1::text IS NULL OR kind = $1)
       AND ($2::uuid IS NULL OR (created_at, id) < (
         SELECT created_at, id FROM social_product_feedback WHERE id = $2
       ))
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [kind, before, PAGE_SIZE + 1],
    { label: "feedback.list" },
  );
  const items = rows.slice(0, PAGE_SIZE);
  return { items, next: rows.length > PAGE_SIZE ? items.at(-1)!.id : null };
}

export async function reviewFeedback(id: string) {
  const result = await autocommitWrite(
    primaryPool(), "social", "social_product_feedback",
    `UPDATE social_product_feedback SET reviewed_at = COALESCE(reviewed_at, now()) WHERE id = $1`,
    [id],
  );
  return result.rowCount === 1;
}
