import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";

/**
 * Who may edit a sale's public details (R3-24): the wallet that holds the
 * sale's `PresaleCap`, read live from Sui mainnet.
 *
 * Why the cap and not "the creating wallet" the ticket names: no read the web
 * has publishes a sale's creator. `chain_read_v1.presales` carries no
 * `creator` column (blast-infra keeps it in its own `presales` table), no
 * presale event carries one, and the presale projection names only the cap.
 * The cap is what the chain itself treats as the sale's authority (it opens
 * and cancels the sale), and Create's publish plan sends it to the creating
 * wallet, so for a sale published through Blast the two are the same wallet;
 * if a creator later hands the cap to a team wallet, that wallet edits.
 *
 * The `Presale` object's second field is its `presale_cap_id` (after its
 * `UID`; the SDK's `presaleBcs`), so the cap id is the content's bytes 32 to
 * 64; the cap's owner is then one object read. A cap that is shared, wrapped
 * or object-owned has no editor. Answers are kept `cacheMs` per sale (a
 * signed-in sale page asks on every view); a failed read is not kept and
 * throws.
 */
export type SaleEditorSource = (presaleId: string) => Promise<string | null>;

/** The fullnode read this needs: `SuiGrpcClient.core.getObject`'s shape. */
export interface SaleEditorFullnode {
  getObject(input: Readonly<{ objectId: string; include?: Readonly<{ content?: boolean }>; signal?: AbortSignal }>): Promise<
    Readonly<{
      object: Readonly<{
        type: string;
        owner: Readonly<{ $kind: string; AddressOwner?: string }>;
        content?: Uint8Array | null;
      }>;
    }>
  >;
}

const PRESALE_TYPE = /^0x[0-9a-f]+::blast_presale::Presale</;

function hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export function presaleCapEditor(
  fullnode: () => SaleEditorFullnode,
  options: Readonly<{ cacheMs?: number; timeoutMs?: number; now?: () => number; maxEntries?: number }> = {},
): SaleEditorSource {
  const cacheMs = options.cacheMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 1_000;
  const cache = new Map<string, { at: number; editor: string | null }>();
  return async (presaleId) => {
    const hit = cache.get(presaleId);
    if (hit && now() - hit.at < cacheMs) return hit.editor;
    const signal = AbortSignal.timeout(timeoutMs);
    const node = fullnode();
    const { object: presale } = await node.getObject({ objectId: presaleId, include: { content: true }, signal });
    let editor: string | null = null;
    if (PRESALE_TYPE.test(presale.type) && presale.content && presale.content.length >= 64) {
      const capId = normalizeSuiObjectId(hex(presale.content.subarray(32, 64)));
      const { object: cap } = await node.getObject({ objectId: capId, signal });
      editor = cap.owner.$kind === "AddressOwner" && cap.owner.AddressOwner ? normalizeSuiAddress(cap.owner.AddressOwner) : null;
    }
    cache.delete(presaleId);
    cache.set(presaleId, { at: now(), editor });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
    return editor;
  };
}
