import { downloadBlob } from "#web/lib/download-blob.ts";
import { quoteDisplaySymbol } from "./quote-coins";
import { useCallback, useEffect, useState, type RefObject } from "react";
import type { AllowlistEntriesResponse, AllowlistResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import type { CreateQuote } from "@blast/core/web/contracts/create.ts";
import { allowlistFitsQuote, draftQuote } from "@blast/core/modules/social/create/model.ts";
import { ALLOWLIST_FILE_MAX_BYTES, parseAllowlist, type AllowlistRowError, type ParsedAllowlist } from "./allowlist-csv";
import { fetchAllowlistEntries, uploadAllowlist, type CreateApiOptions } from "./create-client";
import { createStore, type CreateState } from "./create-store";
import type { AllowlistActions } from "./AllowlistCard";
import { originalAllowlistCsv, savedAllowlistCsv } from "./saved-allowlist";
import { atomsText } from "@blast/core/web/format.ts";

type ListReview = Readonly<{
  parsed: ParsedAllowlist; fileName: string; quote: CreateQuote; draftId: string | null;
  controller: AbortController; errors: readonly AllowlistRowError[]; uploadError: string | null;
  saved?: boolean;
  savedId?: string;
}>;

function adoptUploaded(body: AllowlistResponse, parsed: ParsedAllowlist, quote: CreateQuote) {
  createStore.set({ localAllowlist: { n: body.entry_count, min: parsed.min, max: parsed.max, quoteType: quote.quote_type } });
  createStore.edit((draft) => ({ ...draft, allowlist_id: body.allowlist_id }));
}

export function useAllowlistUpload({ state, api, session }: Readonly<{
  state: CreateState; api(signal?: AbortSignal): CreateApiOptions; session: RefObject<AbortController | null>;
}>) {
  const toast = useToast();
  const [listReview, setListReview] = useState<ListReview | null>(null);
  const [holderChoice, setHolderChoice] = useState({ draftId: state.draftId, include: false });
  const includeHolders = holderChoice.draftId === state.draftId && holderChoice.include;
  const [saved, setSaved] = useState<Readonly<{ id: string; list: AllowlistEntriesResponse }> | null>(null);
  const [uploaded, setUploaded] = useState<Readonly<{ id: string; fileName: string }> | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [failedRead, setFailedRead] = useState<string | null>(null);
  const readError = Boolean(state.draft.allowlist_id && failedRead === state.draft.allowlist_id);
  const id = state.draft.allowlist_id;
  const savedList = saved?.id === id ? saved.list : null;

  useEffect(() => {
    if (!id || state.phase !== "ready" || createStore.get().phase !== "ready" || !session.current || session.current.signal.aborted) return;
    const controller = new AbortController();
    void fetchAllowlistEntries(api(controller.signal), id).then((result) => {
      if (controller.signal.aborted) return;
      if (result.status === "ok") { setSaved({ id, list: result.body }); setFailedRead(null); }
      else setFailedRead(id);
    }).catch(() => { if (!controller.signal.aborted) setFailedRead(id); });
    return () => controller.abort();
  }, [id, state.phase, api, session]);

  const onList = useCallback((file: File) => {
    const controller = session.current;
    const current = createStore.get();
    if (!controller || controller.signal.aborted || current.phase !== "ready" || current.allowlistUploading || current.publishLocked) return;
    if (file.size > ALLOWLIST_FILE_MAX_BYTES) {
      toast("Your list is too large", { sub: "Use a CSV under 4 MB.", tone: "error", id: "allowlist-upload" });
      return;
    }
    const quote = draftQuote(current.draft);
    createStore.set({ allowlistUploading: true });
    void file.text().then((text) => {
      if (controller.signal.aborted || createStore.get().draftId !== current.draftId) return;
      setListReview({ parsed: parseAllowlist(text, quote.decimals, quote.symbol), fileName: file.name, quote, draftId: current.draftId, controller, errors: [], uploadError: null });
    }).catch(() => {
      if (!controller.signal.aborted) toast("Your file couldn’t be read", { sub: "Save it as a CSV, then try again.", tone: "error", id: "allowlist-upload" });
    }).finally(() => { if (!controller.signal.aborted) createStore.set({ allowlistUploading: false }); });
  }, [session, toast]);

  const acceptList = () => {
    const current = createStore.get();
    if (!listReview || listReview.saved || listReview.parsed.errorCount || listReview.errors.length || current.allowlistUploading || current.publishLocked) return;
    const { controller, parsed, quote, fileName } = listReview;
    const sameDraft = () => session.current === controller && isCurrentList(listReview, createStore.get());
    if (!sameDraft()) return setListReview(null);
    createStore.set({ allowlistUploading: true });
    setListReview({ ...listReview, uploadError: null });
    const include = savedList?.source?.include_blast_holders ?? includeHolders;
    void uploadAllowlist(api(controller.signal), new Blob([parsed.csv], { type: "text/csv" }), quote.quote_type, include, fileName).then((result) => {
      if (!sameDraft()) return;
      if (result.status !== "ok") {
        const errors = result.status === "refused" ? allowlistServerErrors(result.error, parsed) : [];
        setListReview((review) => review && { ...review, errors, uploadError: allowlistUploadError(result) });
        return;
      }
      adoptUploaded(result.body, parsed, quote);
      setUploaded({ id: result.body.allowlist_id, fileName });
      setListReview(null);
      toast("Allowlist uploaded", { sub: `${fileName} · ${result.body.entry_count.toLocaleString("en-US")} wallets saved.`, id: "allowlist-upload" });
    }).catch(() => {
      if (sameDraft()) setListReview((review) => review && { ...review, uploadError: "Your current list is unchanged. Check your connection and try again." });
    }).finally(() => { if (!controller.signal.aborted) createStore.set({ allowlistUploading: false }); });
  };

  const toggleHolders = (include: boolean) => {
    if (!id) return setHolderChoice({ draftId: state.draftId, include });
    const controller = session.current;
    if (!savedList?.source || !controller || state.allowlistUploading || state.publishLocked) return;
    const quote = draftQuote({ quote_type: savedList.quote });
    const parsed = parseAllowlist(savedAllowlistCsv({ ...savedList, entries: savedList.entries.slice(0, savedList.source.uploaded_count) }, quote.decimals), quote.decimals, quote.symbol);
    createStore.set({ allowlistUploading: true });
    void uploadAllowlist(api(controller.signal), new Blob([originalAllowlistCsv(savedList)], { type: "text/csv" }), savedList.quote, include, savedList.source.file_name).then((result) => {
      if (controller.signal.aborted || createStore.get().draft.allowlist_id !== id) return;
      if (result.status !== "ok") return toast("Allowlist unchanged", { sub: allowlistUploadError(result), tone: "error", id: "allowlist-upload" });
      adoptUploaded(result.body, parsed, quote);
      setUploaded({ id: result.body.allowlist_id, fileName: savedList.source!.file_name });
      toast(include ? "Card holders included" : "Card holders removed", { sub: `${result.body.entry_count.toLocaleString("en-US")} wallets saved.`, id: "allowlist-upload" });
    }).catch(() => {
      if (!controller.signal.aborted) toast("Allowlist unchanged", { sub: "Check your connection, then try again.", tone: "error", id: "allowlist-upload" });
    }).finally(() => { if (!controller.signal.aborted) createStore.set({ allowlistUploading: false }); });
  };

  const openSaved = (list: AllowlistEntriesResponse) => {
    const controller = session.current;
    if (!controller || controller.signal.aborted) return;
    const quote = listQuote(list.quote, state.draft.quote_type);
    setListReview({ parsed: parseAllowlist(savedAllowlistCsv(list, quote.decimals), quote.decimals, quote.symbol), fileName: list.source?.file_name ?? "allowlist.csv", quote, draftId: state.draftId, controller, errors: [], uploadError: null, saved: true, savedId: id ?? undefined });
  };
  const downloadSaved = (list: AllowlistEntriesResponse) => {
    const csv = savedAllowlistCsv(list, draftQuote({ quote_type: list.quote }).decimals);
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), list.source?.file_name ?? "allowlist.csv");
  };
  const withSaved = (action: (list: AllowlistEntriesResponse) => void) => {
    if (savedList) return action(savedList);
    const controller = session.current;
    if (!id || !controller || controller.signal.aborted || retrying) return;
    const current = () => session.current === controller && !controller.signal.aborted && createStore.get().draft.allowlist_id === id && createStore.get().draftId === state.draftId;
    const failed = () => {
      if (!current()) return;
      setFailedRead(id);
      toast("Your list couldn’t load", { sub: "Your saved list is unchanged. Try again.", tone: "error", id: "allowlist-read" });
    };
    setRetrying(true);
    return fetchAllowlistEntries(api(controller.signal), id).then((result) => {
      if (!current()) return;
      if (result.status !== "ok") return failed();
      setSaved({ id, list: result.body });
      setFailedRead(null);
      toast("Allowlist ready", { id: "allowlist-read" });
      action(result.body);
    }).catch(failed).finally(() => setRetrying(false));
  };
  const source = savedList?.source;
  const actions: AllowlistActions = {
    fileName: source?.file_name ?? (uploaded?.id === id ? uploaded.fileName : null),
    includeHolders: source?.include_blast_holders ?? includeHolders,
    holderSummary: holderSummary(savedList, readError, state.draft.quote_type),
    pending: retrying || Boolean(id && !savedList && !readError),
    canToggle: canToggleHolders(state, savedList),
    onToggle: toggleHolders, onReview: () => { void withSaved(openSaved); }, onDownload: () => { void withSaved(downloadSaved); },
  };
  return {
    onList, acceptList, actions,
    closeList: () => {
      setListReview(null);
      document.querySelector<HTMLButtonElement>('[data-f="allowlist"][data-cr-upload]')?.focus({ preventScroll: true });
    },
    listReview: listReview && isCurrentList(listReview, state) ? listReview : null,
  };
}

function canToggleHolders(state: CreateState, list: AllowlistEntriesResponse | null): boolean {
  if (state.phase !== "ready" || state.publishLocked) return false;
  return !state.draft.allowlist_id || Boolean(list?.source && allowlistFitsQuote(list.quote, state.draft.quote_type));
}

function isCurrentList(review: ListReview, current: CreateState): boolean {
  return !review.controller.signal.aborted && current.phase === "ready" &&
    current.draftId === review.draftId && (review.saved ? current.draft.allowlist_id === review.savedId : current.draft.quote_type === review.quote.quote_type) &&
    current.draft.eligibility === "allowlist";
}

function allowlistServerErrors(error: Readonly<Record<string, unknown>>, parsed: ParsedAllowlist): AllowlistRowError[] {
  if (!Array.isArray(error.rows)) return [];
  return error.rows.flatMap((row: unknown) => {
    if (!row || typeof row !== "object" || !("row" in row) || !("reason" in row) || typeof row.row !== "number" || typeof row.reason !== "string") return [];
    const entry = parsed.entries[row.row - 1];
    return entry ? [serverRowError(row.reason, entry, parsed)] : [];
  }).toSorted((a, b) => a.line - b.line);
}

function serverRowError(reason: string, entry: ParsedAllowlist["entries"][number], parsed: ParsedAllowlist): AllowlistRowError {
  const known: Readonly<Record<string, Pick<AllowlistRowError, "field" | "reason" | "category">>> = {
    "a row needs exactly a wallet and a cap": { field: "Row", category: "columns", reason: "Expected two columns: address,amount" },
    "invalid address": { field: "Address", category: "address", reason: "Invalid Sui address" },
    "cap must be a base-10 integer string": { field: "Amount", category: "number", reason: "Invalid number" },
    "cap must be a base-10 integer": { field: "Amount", category: "number", reason: "Invalid number" },
    "cap must be at least 1": { field: "Amount", category: "zero", reason: "Must be greater than zero" },
    "cap exceeds the u64 maximum": { field: "Amount", category: "maximum", reason: "Exceeds supported maximum" },
  };
  const firstRow = /^duplicate wallet \(first on row ([1-9][0-9]*)\)$/.exec(reason)?.[1];
  const original = firstRow ? parsed.entries[Number(firstRow) - 1] : null;
  const knownIssue = Object.hasOwn(known, reason) ? known[reason] : null;
  const issue = firstRow ? { field: "Address" as const, category: "duplicate" as const, reason: original ? `Duplicate wallet; first on line ${original.line}` : "Duplicate wallet" }
    : knownIssue ?? { field: "Row" as const, category: "other" as const, reason: "Check this address and contribution limit" };
  const value = issue.field === "Address" ? entry.sourceAddress : issue.field === "Amount" ? entry.sourceAmount : `${entry.sourceAddress},${entry.sourceAmount}`;
  return { line: entry.line, value, ...issue };
}

function allowlistUploadError(result: Awaited<ReturnType<typeof uploadAllowlist>>): string {
  if (result.status === "refused" && result.code === "unauthorized") return "Sign in with X or Google, then try again. Your current list is unchanged.";
  if (result.status === "refused" && result.code === "allowlist_too_large") return "Use a CSV under 4 MB with at most 65,536 wallets. Your current list is unchanged.";
  return "Your current list is unchanged. Try again in a moment.";
}

/** The coin a saved list's caps read in: the sale's when the list carries over to it (USDC and USDsui), else the list's own. */
function listQuote(quote: string, saleQuote: string): CreateQuote {
  return draftQuote({ quote_type: allowlistFitsQuote(quote, saleQuote) ? saleQuote : quote });
}

function holderSummary(list: AllowlistEntriesResponse | null, readError: boolean, saleQuote: string): string | null {
  if (readError) return "List details couldn’t load. Try Review to retry.";
  if (list?.source === null) return "Replace this older list to change holder inclusion.";
  if (!list?.source?.include_blast_holders) return null;
  const source = list.source;
  const quote = listQuote(list.quote, saleQuote);
  return `${source.added_count.toLocaleString("en-US")} added · ${atomsText(source.holder_cap ?? "0", quote.decimals)} ${quoteDisplaySymbol(quote.symbol)} max each`;
}
