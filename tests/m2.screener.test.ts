import { describe, expect, it } from "vitest";
import { Screener } from "../src/screener/screener";
import { mapMeteoraPair } from "../src/screener/sources/meteora";
import { DAY, HOUR } from "../src/types";
import { cleanMint, FakeChain, FakeJupiter, FakeMarket, FakePools, FakeRug, NOW, pool, tok } from "./fakes";
import { config, makeStore, testClock } from "./helpers";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function setup() {
  const clock = testClock(NOW);
  const { store } = makeStore(clock);
  const cfg = config();
  const deps = {
    pools: [new FakePools([])],
    market: new FakeMarket(),
    jupiter: new FakeJupiter(),
    rugcheck: new FakeRug(),
    chain: new FakeChain(),
  };
  return { store, cfg, deps, clock, screener: new Screener(store, cfg, deps) };
}

const reasonsFor = (res: Awaited<ReturnType<Screener["run"]>>, poolAddr: string) =>
  res.rejected.find((r) => r.pool === poolAddr)?.reasons ?? [];

describe("Screener stages 1–6", () => {
  it("shortlists good pools and rejects scams with the right reasons", async () => {
    const { deps, screener, store } = setup();
    const good = pool(tok("GoodMint", "MOODENG", "Moo Deng"), { address: "good" });
    const realBonk = pool(tok(BONK, "Bonk"), { address: "bonk-real" });
    const fakeBonk = pool(tok("FakeBonk", "B0NK", "Bonk"), { address: "bonk-fake" });
    const fakeUsdc = pool(tok("FakeUsdc", "USDC.", "USD Coin"), { address: "usdc-fake" });
    const airdrop = pool(tok("Air", "CLAIM", "Claim airdrop at jup-claim.io"), { address: "airdrop" });
    const mintAuth = pool(tok("MintAuth", "PRINT"), { address: "mint-auth" });
    const honeypot = pool(tok("Honey", "HONEY"), { address: "honeypot" });
    const wash = pool(tok("Wash", "WASH"), { address: "wash", volume24hUsd: 500_000 * 80 });
    const tiny = pool(tok("Tiny", "TINY"), { address: "tiny", tvlUsd: 5_000 });
    const young = pool(tok("Young", "YOUNG"), { address: "young" });
    const noBase = { ...pool(tok("A", "A")), tokenY: tok("B", "B"), address: "no-base" };
    deps.pools = [new FakePools([good, realBonk, fakeBonk, fakeUsdc, airdrop, mintAuth, honeypot, wash, tiny, young, noBase])];
    (deps.chain as FakeChain).facts.set("MintAuth", cleanMint("MintAuth", { mintAuthority: "Dev" }));
    (deps.jupiter as FakeJupiter).roundtrip.set("Honey", null);
    (deps.market as FakeMarket).pool.set("young", { pairCreatedAt: NOW - 2 * HOUR, txns24h: 9000, uniqueTraders24h: 2000 });

    const screener2 = new Screener(store, config(), deps);
    const res = await screener2.run();
    void screener;

    const shortlisted = res.shortlist.map((s) => s.cand.pool.address);
    expect(shortlisted).toContain("good");
    expect(shortlisted).toContain("bonk-real");
    expect(shortlisted).not.toContain("no-base");

    expect(reasonsFor(res, "bonk-fake")).toContain("IMPERSONATOR:BONK");
    expect(reasonsFor(res, "usdc-fake")).toContain("IMPERSONATOR:USDC");
    expect(reasonsFor(res, "airdrop").some((r) => r.startsWith("METADATA"))).toBe(true);
    expect(reasonsFor(res, "mint-auth")).toContain("MINT_AUTHORITY_NOT_REVOKED");
    expect(reasonsFor(res, "honeypot")).toContain("HONEYPOT:NO_SELL_ROUTE");
    expect(reasonsFor(res, "wash").some((r) => r.startsWith("WASH_TRADING_VOLUME_TVL"))).toBe(true);
    expect(reasonsFor(res, "tiny").some((r) => r.startsWith("TVL_TOO_LOW"))).toBe(true);
    expect(reasonsFor(res, "young").some((r) => r.startsWith("POOL_TOO_NEW"))).toBe(true);

    // Persistence
    const cands = store.db.all<{ pool: string; rank: number }>("SELECT pool, rank FROM candidates WHERE run_id = ?", [res.runId]);
    expect(cands.map((c) => c.pool).sort()).toEqual([...shortlisted].sort());
    expect(store.getToken("MintAuth")?.status).toBe("REJECT");
    expect(store.getToken("GoodMint")?.status).toBe("PASS");
    const logged = store.db.all<{ pool: string }>("SELECT pool FROM screen_rejections WHERE run_id = ?", [res.runId]).map((r) => r.pool);
    expect(logged).toContain("honeypot");
    expect(logged).not.toContain("tiny"); // bulk size rejections are not logged
  });

  it("rejects duplicates of a non-major symbol in favour of the canonical mint", async () => {
    const { deps, store, cfg } = setup();
    const real = pool(tok("RealPop", "POPX"), { address: "real", tvlUsd: 2_000_000 });
    const dupe = pool(tok("DupePop", "POPX"), { address: "dupe", tvlUsd: 400_000 });
    deps.pools = [new FakePools([real, dupe])];
    (deps.market as FakeMarket).token.set("RealPop", { firstPairCreatedAt: NOW - 200 * DAY, liquidityUsd: 2e6 });
    (deps.market as FakeMarket).token.set("DupePop", { firstPairCreatedAt: NOW - 10 * DAY, liquidityUsd: 4e5 });
    const res = await new Screener(store, cfg, deps).run();
    expect(res.shortlist.map((s) => s.cand.pool.address)).toEqual(["real"]);
    expect(reasonsFor(res, "dupe")).toContain("IMPERSONATOR:DUPLICATE_SYMBOL:POPX");
  });

  it("catches an impersonator via on-chain metadata even if the API label is clean", async () => {
    const { deps, store, cfg } = setup();
    deps.pools = [new FakePools([pool(tok("Sneaky", "SNKY"), { address: "sneaky" })])];
    (deps.chain as FakeChain).meta.set("Sneaky", { mint: "Sneaky", symbol: "JUP", name: "Jupiter" });
    const res = await new Screener(store, cfg, deps).run();
    expect(res.shortlist).toHaveLength(0);
    expect(reasonsFor(res, "sneaky")).toContain("IMPERSONATOR:JUP");
  });

  it("rejects a pool whose TVL dropped >30% in 24h", async () => {
    const { deps, store, cfg, clock } = setup();
    const p = pool(tok("Drain", "DRAIN"), { address: "drain", tvlUsd: 1_000_000 });
    deps.pools = [new FakePools([p])];
    await new Screener(store, cfg, deps).run();
    clock.advance(24 * HOUR);
    (deps.pools[0] as FakePools).pools = [{ ...p, tvlUsd: 500_000, volume24hUsd: 1_000_000 }];
    const res = await new Screener(store, cfg, deps).run();
    expect(reasonsFor(res, "drain").some((r) => r.startsWith("TVL_DROP_24H"))).toBe(true);
  });

  it("scores higher real fee APR above lower", async () => {
    const { deps, store, cfg } = setup();
    deps.pools = [
      new FakePools([
        pool(tok("Hi", "HIFEE"), { address: "hi", fees24hUsd: 5_000 }),
        pool(tok("Lo", "LOFEE"), { address: "lo", fees24hUsd: 200 }),
      ]),
    ];
    const res = await new Screener(store, cfg, deps).run();
    expect(res.shortlist[0]!.cand.pool.address).toBe("hi");
    expect(res.shortlist[0]!.cand.metrics.fee_apr).toBeCloseTo((5000 / 500_000) * 365 * 100);
  });

  it("re-checks held tokens and flags them", async () => {
    const { deps, store, cfg } = setup();
    (deps.chain as FakeChain).facts.set("Held", cleanMint("Held", { freezeAuthority: "NewAuth" }));
    const [r] = await new Screener(store, cfg, deps).recheckTokens(["Held"]);
    expect(r!.pass).toBe(false);
    expect(store.getToken("Held")?.status).toBe("REJECT");
  });
});

describe("Meteora API mapping", () => {
  it("maps a pair and tolerates string numbers", () => {
    const p = mapMeteoraPair({
      address: "Addr", name: "MOODENG-SOL", mint_x: "X", mint_y: "So11111111111111111111111111111111111111112",
      reserve_x: "rx", reserve_y: "ry", bin_step: 80, base_fee_percentage: "0.8", liquidity: "123456.7",
      trade_volume_24h: 1000, fees_24h: "12.5", current_price: 0.0001, hide: false, is_blacklisted: false,
    })!;
    expect(p.tokenX.symbol).toBe("MOODENG");
    expect(p.feeBps).toBeCloseTo(80);
    expect(p.tvlUsd).toBeCloseTo(123456.7);
    expect(p.reserves).toEqual(["rx", "ry"]);
  });
});
