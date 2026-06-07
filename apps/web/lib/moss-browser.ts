// ---------------------------------------------------------------------------
// Browser-side Moss search (Steps 2/3 + mark-sold replacement).
//
// Loads the flagship @inferedge/moss image AND catalog indexes entirely in the
// browser, then answers sub-10ms queries with ZERO network calls:
//   - queryImages: per-token / speculative visual grounding (Steps 2 & 3)
//   - queryCatalog: instant "next car" replacement when a car is marked sold
// ---------------------------------------------------------------------------

import { getMossConfig } from "@/lib/api";

type QueryDoc = { id: string; text: string; score: number; metadata?: Record<string, string> };
type SearchResult = { docs: QueryDoc[]; query: string; timeTakenInMs?: number };
type MossClientLike = {
  loadIndex(name: string, opts?: unknown): Promise<string>;
  query(name: string, q: string, opts?: { topK?: number; filter?: unknown }): Promise<SearchResult>;
};

export type GroundHit = { id: string; url?: string; role?: string; score: number };
export type CarHit = {
  vin: string;
  title: string;
  price?: string;
  body?: string;
  drivetrain?: string;
  fuel?: string;
  score: number;
};

export type BrowserMoss = {
  imagesIndex: string | null;
  catalogIndex: string | null;
  /** Visual grounding: semantic image search filtered to one car (vin). */
  queryImages(text: string, vin: string, topK?: number): Promise<{ hits: GroundHit[]; ms: number }>;
  /** Cross-sell: semantic catalog search, excluding given vins (e.g. the sold car). */
  queryCatalog(text: string, excludeVins: string[], topK?: number): Promise<{ cars: CarHit[]; ms: number }>;
};

let mossPromise: Promise<BrowserMoss | null> | undefined;

// Idempotent: kicks off (and caches) the one-time index + model downloads.
export function loadBrowserMoss(): Promise<BrowserMoss | null> {
  if (!mossPromise) {
    mossPromise = build().catch((err) => {
      mossPromise = undefined; // allow retry on next call
      console.warn("[moss] browser search failed to load:", err);
      return null;
    });
  }
  return mossPromise;
}

async function build(): Promise<BrowserMoss | null> {
  const cfg = await getMossConfig();
  const mod = (await import("@inferedge/moss")) as unknown as {
    MossClient: new (id: string, key: string) => MossClientLike;
  };
  const client = new mod.MossClient(cfg.projectId, cfg.projectKey);
  const imagesIndex = cfg.imagesIndex;
  const catalogIndex = cfg.catalogIndex;
  // Load both indexes in parallel (each: one-time assets + model download).
  await Promise.all([
    imagesIndex ? client.loadIndex(imagesIndex) : Promise.resolve(),
    catalogIndex ? client.loadIndex(catalogIndex) : Promise.resolve()
  ]);

  return {
    imagesIndex,
    catalogIndex,
    async queryImages(text, vin, topK = 1) {
      if (!imagesIndex) return { hits: [], ms: 0 };
      const res = await client.query(imagesIndex, text, {
        topK,
        filter: { field: "vin", condition: { $eq: vin } }
      });
      const hits: GroundHit[] = res.docs.map((d) => ({
        id: d.id,
        url: d.metadata?.url,
        role: d.metadata?.role,
        score: d.score
      }));
      return { hits, ms: res.timeTakenInMs ?? 0 };
    },
    async queryCatalog(text, excludeVins, topK = 3) {
      if (!catalogIndex) return { cars: [], ms: 0 };
      // Over-fetch so we still have results after dropping excluded/sold vins.
      const res = await client.query(catalogIndex, text, { topK: topK + excludeVins.length + 2 });
      const exclude = new Set(excludeVins);
      const cars: CarHit[] = res.docs
        .filter((d) => (d.metadata?.doc_type ?? "car") === "car")
        .map((d) => ({
          vin: d.metadata?.car_id ?? d.id,
          title: d.metadata?.title ?? d.id,
          price: d.metadata?.price,
          body: d.metadata?.opt_body,
          drivetrain: d.metadata?.opt_drivetrain,
          fuel: d.metadata?.opt_fuel,
          score: d.score
        }))
        .filter((c) => !exclude.has(c.vin))
        .slice(0, topK);
      return { cars, ms: res.timeTakenInMs ?? 0 };
    }
  };
}
