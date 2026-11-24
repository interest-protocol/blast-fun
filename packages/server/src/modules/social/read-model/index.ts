/**
 * The social feed's read model: the naming rule and the entry selections that
 * every feed, profile, reaction and why check uses. Privacy is evaluated here,
 * at read time; callers never re-derive it.
 */
export {
  PERSON_ENTRY_KINDS,
  TRADE_ENTRY_KINDS,
  namedOwnerSql,
  namedWalletsSql,
  personEntrySql,
  presalePostSql,
  visibleEntrySql,
  type PersonEntryKind,
} from "@blast/core/modules/social/read-model/naming.ts";
export {
  EntryQueryError,
  MAX_ENTRY_PAGE,
  entryBranchFilterSql,
  entryFromRow,
  entryIdBranch,
  isVisible,
  personEntriesOf,
  presalePostEntriesOf,
  visibleEntry,
  type EntryCursor,
  type EntryWindow,
  type FeedEntry,
  type PresalePostThresholds,
} from "@blast/core/modules/social/read-model/entries.ts";
