import { useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { CREATE_QUOTE_TYPE, CREATE_SUI_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { CreateForm } from "#web/components/social/create/CreateForm.tsx";
import { QuotePicker } from "#web/components/social/create/QuotePicker.tsx";
import { AllowlistReview } from "#web/components/social/create/AllowlistReview.tsx";
import { useAllowlistUpload } from "#web/components/social/create/use-allowlist-upload.ts";
import { createStore, issuesOf, useCreateState } from "#web/components/social/create/create-store.ts";
import { ToastProvider } from "#web/components/blast-ui/Toasts.tsx";
import { ShellActionsProvider } from "#web/components/blast-ui/shell-actions.tsx";
import { filledSample } from "../../../../../../../packages/core/test/fixtures/social/create/create-fixtures.ts";
import type { AllowlistEntriesResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import "#web/components/blast-ui/blast-ui.css";
import "./fixture.css";

// Browser-only fixtures. The actual route and database are verified by integration tests.
const manifests = new Map<string, AllowlistEntriesResponse>();
let failNext = false;
let failReads = false;
const wallet = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const request: typeof fetch = async (input, init) => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (String(input).endsWith("/entries")) {
    if (failReads) return Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
    const id = String(input).split("/").at(-2)!;
    const list = manifests.get(id);
    return list ? Response.json(list) : Response.json({ error: { code: "not_found" } }, { status: 404 });
  }
  if (failNext) { failNext = false; return Response.json({ error: { code: "service_unavailable" } }, { status: 503 }); }
  const form = init!.body as FormData;
  const file = form.get("file") as File;
  const original = (await file.text()).trim().split("\n").slice(1).map((line) => {
    const [wallet, cap] = line.split(","); return { wallet, cap: cap as `${bigint}` };
  });
  const mean = original.reduce((sum, entry) => sum + BigInt(entry.cap), 0n) / BigInt(original.length);
  const include = form.get("include_blast_holders") === "true";
  const entries = new Map(original.map((entry) => [entry.wallet, entry]));
  if (include) for (const address of [wallet(90001), wallet(90002)]) if (!entries.has(address)) entries.set(address, { wallet: address, cap: `${mean}` });
  const id = crypto.randomUUID();
  manifests.set(id, { quote: String(form.get("quote")), source: { file_name: file.name, uploaded_count: original.length, include_blast_holders: include, added_count: entries.size - original.length, holder_cap: include ? `${mean}` : null }, entries: [...entries.values()] });
  return Response.json({ allowlist_id: id, entry_count: entries.size, leaf_count: String(entries.size), root: "fixture", total_cap: [...entries.values()].reduce((sum, e) => sum + BigInt(e.cap), 0n).toString(), warnings: [] }, { status: 201 });
};

function reset() {
  createStore.reset({ phase: "ready", ownerId: "fixture", draftId: crypto.randomUUID(), draft: { ...filledSample(), eligibility: "allowlist", lift: true, lift_access: "anyone", lift_max_wallets: 40000, lift_min: 10, launch_when_filled: true },
    quotes: [CREATE_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE], suiPrice: { usd_price: "3.42", as_of_ms: Date.now() },
    cetusTiers: { [CREATE_QUOTE_TYPE]: [[200, 10000]], [CREATE_SUI_QUOTE_TYPE]: [[200, 10000]] }, bluefinOptions: { status: "ready", min_tick: -443636, max_tick: 443636 } });
}
reset();
Object.assign(window, { presaleFixture: { store: createStore, reset, failReads: (value: boolean) => { failReads = value; }, failNext: () => { failNext = true; }, csv: "address,amount\n" + Array.from({ length: 20 }, (_, i) => `${wallet(i + 1)},${(i + 1) * 25}`).join("\n") } });

function Fixture() {
  const state = useCreateState();
  const session = useRef(new AbortController());
  const api = useCallback((signal?: AbortSignal) => ({ signal, fetch: request, getAccessToken: async () => "fixture-token" }), []);
  const upload = useAllowlistUpload({ state, api, session });
  return <><div className="fixture-label">Verification fixture · Simulated API responses</div><main className="fixture-main"><h1>Create a presale</h1><CreateForm state={state} issues={issuesOf(state)} allowlistActions={upload.actions} onList={upload.onList} onLogo={() => {}} /><QuotePicker state={state} />{upload.listReview ? <AllowlistReview saved={upload.listReview.saved} parsed={upload.listReview.parsed} fileName={upload.listReview.fileName} symbol={upload.listReview.quote.symbol} errors={upload.listReview.errors} uploadError={upload.listReview.uploadError} busy={state.allowlistUploading} onAccept={upload.acceptList} onClose={upload.closeList} /> : null}</main></>;
}
createRoot(document.getElementById("app")!).render(<ShellActionsProvider><ToastProvider><Fixture /></ToastProvider></ShellActionsProvider>);
