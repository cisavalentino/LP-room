import { Connection, PublicKey, type Commitment } from "@solana/web3.js";
import {
  AccountState,
  ExtensionType,
  getDefaultAccountState,
  getExtensionTypes,
  getPausableConfig,
  getPermanentDelegate,
  getTransferFeeConfig,
  getTransferHook,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from "@solana/spl-token";
import type { TokenMeta } from "../screener/types";

/** On-chain facts about a mint. Read directly via RPC — the final word on safety. */
export interface MintFacts {
  mint: string;
  program: "spl" | "token2022" | "not_a_mint";
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Token-2022 extension names, e.g. ["TransferFeeConfig", "MetadataPointer"]. */
  extensions: string[];
  /** Max of older/newer transfer fee, in bps. */
  transferFeeBps: number;
  transferHookProgram: string | null;
  permanentDelegate: string | null;
  defaultAccountStateFrozen: boolean;
  pausable: boolean;
}

export interface HolderFact {
  tokenAccount: string;
  owner: string;
  amount: bigint;
  /** Program that owns the holder's *owner* account (e.g. a DEX program for pool PDAs). null = no account / system wallet. */
  ownerProgram: string | null;
}

/** Read-only chain access. Deliberately has no send / sign capability. */
export interface ChainReader {
  getMintFacts(mint: string): Promise<MintFacts>;
  getLargestHolders(mint: string): Promise<HolderFact[]>;
  /** DAS getAsset (Helius). null when unsupported. */
  getAssetMeta(mint: string): Promise<TokenMeta | null>;
  /** First wallet that funded `wallet` with SOL; null = unknown. */
  fundingSource(wallet: string): Promise<string | null>;
}

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export class RpcChainReader implements ChainReader {
  readonly conn: Connection;
  constructor(
    private readonly url: string,
    commitment: Commitment = "confirmed",
  ) {
    this.conn = new Connection(url, { commitment, disableRetryOnRateLimit: false });
  }

  async getMintFacts(mint: string): Promise<MintFacts> {
    const pk = new PublicKey(mint);
    const info = await this.conn.getAccountInfo(pk);
    const notMint: MintFacts = {
      mint, program: "not_a_mint", decimals: 0, supply: 0n, mintAuthority: null, freezeAuthority: null,
      extensions: [], transferFeeBps: 0, transferHookProgram: null, permanentDelegate: null,
      defaultAccountStateFrozen: false, pausable: false,
    };
    if (!info) return notMint;
    const is2022 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
    if (!is2022 && !info.owner.equals(TOKEN_PROGRAM_ID)) return notMint;
    const m = unpackMint(pk, info, info.owner);
    const facts: MintFacts = {
      ...notMint,
      program: is2022 ? "token2022" : "spl",
      decimals: m.decimals,
      supply: m.supply,
      mintAuthority: m.mintAuthority?.toBase58() ?? null,
      freezeAuthority: m.freezeAuthority?.toBase58() ?? null,
    };
    if (!is2022) return facts;
    const types = getExtensionTypes(m.tlvData);
    facts.extensions = types.map((t) => ExtensionType[t] ?? `Unknown(${t})`);
    const fee = getTransferFeeConfig(m);
    if (fee) {
      facts.transferFeeBps = Math.max(fee.olderTransferFee.transferFeeBasisPoints, fee.newerTransferFee.transferFeeBasisPoints);
    }
    const hook = getTransferHook(m);
    if (hook && !hook.programId.equals(PublicKey.default)) facts.transferHookProgram = hook.programId.toBase58();
    const pd = getPermanentDelegate(m);
    if (pd && !pd.delegate.equals(PublicKey.default)) facts.permanentDelegate = pd.delegate.toBase58();
    const das = getDefaultAccountState(m);
    facts.defaultAccountStateFrozen = das?.state === AccountState.Frozen;
    facts.pausable = !!getPausableConfig(m);
    return facts;
  }

  async getLargestHolders(mint: string): Promise<HolderFact[]> {
    const largest = await this.conn.getTokenLargestAccounts(new PublicKey(mint));
    const accounts = largest.value;
    if (!accounts.length) return [];
    const parsed = await this.conn.getMultipleParsedAccounts(accounts.map((a) => a.address));
    const owners = parsed.value.map((acc) => {
      const data = acc?.data as { parsed?: { info?: { owner?: string } } } | undefined;
      return data?.parsed?.info?.owner ?? null;
    });
    const ownerKeys = owners.map((o) => (o ? new PublicKey(o) : PublicKey.default));
    const ownerInfos = await this.conn.getMultipleAccountsInfo(ownerKeys);
    return accounts.map((a, i) => {
      const ownerInfo = ownerInfos[i];
      const ownerProgram = ownerInfo ? ownerInfo.owner.toBase58() : null;
      return {
        tokenAccount: a.address.toBase58(),
        owner: owners[i] ?? a.address.toBase58(),
        amount: BigInt(a.amount),
        ownerProgram: ownerProgram === SYSTEM_PROGRAM ? null : ownerProgram,
      };
    });
  }

  async getAssetMeta(mint: string): Promise<TokenMeta | null> {
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: mint } }),
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await res.json()) as {
        result?: {
          content?: { json_uri?: string; metadata?: { name?: string; symbol?: string }; links?: { image?: string } };
          token_info?: { decimals?: number };
        };
      };
      const r = j.result;
      if (!r) return null;
      return {
        mint,
        symbol: r.content?.metadata?.symbol ?? "",
        name: r.content?.metadata?.name ?? "",
        decimals: r.token_info?.decimals,
        uri: r.content?.json_uri,
        image: r.content?.links?.image,
      };
    } catch {
      return null;
    }
  }

  async fundingSource(wallet: string): Promise<string | null> {
    try {
      const pk = new PublicKey(wallet);
      let before: string | undefined;
      let oldest: string | undefined;
      for (let page = 0; page < 3; page++) {
        const sigs = await this.conn.getSignaturesForAddress(pk, { before, limit: 1000 });
        if (!sigs.length) break;
        oldest = sigs[sigs.length - 1]!.signature;
        if (sigs.length < 1000) break;
        before = oldest;
      }
      if (!oldest) return null;
      const tx = await this.conn.getParsedTransaction(oldest, { maxSupportedTransactionVersion: 0 });
      for (const ix of tx?.transaction.message.instructions ?? []) {
        const p = (ix as { parsed?: { type?: string; info?: { source?: string; destination?: string } } }).parsed;
        if (p?.type === "transfer" && p.info?.destination === wallet && p.info.source) return p.info.source;
        if (p?.type === "createAccount" && (p.info as { newAccount?: string } | undefined)?.newAccount === wallet) {
          return (p.info as { source?: string }).source ?? null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}
