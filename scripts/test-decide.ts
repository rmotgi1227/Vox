import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import { getCar, listImages, streamDecideTurn } from "@vox/ai";
import { applyAction, planCanvas } from "@vox/agent-core";
import { DEFAULT_VIN, type ViewState, type CanvasAction } from "@vox/core";

function findRootEnv(start: string): string {
  let dir = start;
  while (true) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return ".env";
    dir = parent;
  }
}
config({ path: findRootEnv(process.cwd()) });

async function drain(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += value;
  }
  return out;
}

async function main() {
  const [car, images] = await Promise.all([getCar(DEFAULT_VIN), listImages(DEFAULT_VIN)]);
  if (!car) throw new Error("no car");
  const first = images[0]!;
  let view: ViewState = { layout: "single", items: [{ kind: "image", carId: first.vin, imageId: first.id }] };
  const history: { role: string; text: string }[] = [];
  const catalog = { images, cars: [car] };

  const turns = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ["Show me the interior", "Show me the gear shifter", "zoom in", "how fast is it", "show me four images"];

  for (const message of turns) {
    const t0 = Date.now();
    let reply = "";
    let actions: CanvasAction[] = [];
    let mode = "stream";
    try {
      const res = await streamDecideTurn({ message, viewState: view, car, images, recentTurns: history.slice(-6) });
      reply = await drain(res.reply);          // voice would stream this token-by-token
      actions = await res.actions;             // canvas tail (a beat later)
      if (actions.length === 0 && /\b(here'?s|here is|here are|look|closer|zoom|pull|view of|showing)\b/i.test(reply)) {
        actions = planCanvas(message, images, view); // agent backfill
        mode = "stream+backfill";
      }
    } catch (err) {
      mode = "FALLBACK(429/err)";
      actions = planCanvas(message, images, view);
      reply = actions[0]?.op === "showImages" ? "Here are a few angles." : actions[0]?.op === "zoom" ? "Here's a closer look." : "Here you go.";
    }
    const ms = Date.now() - t0;
    for (const a of actions) view = applyAction(view, a, catalog);
    console.log(`\n▶ "${message}"  (${ms}ms, ${mode})`);
    console.log(`  reply:   ${reply}`);
    console.log(`  actions: ${actions.map((a) => a.op).join(", ") || "(none)"}`);
    console.log(`  → view:  layout=${view.layout} items=${view.items.length} zoom=${view.zoom ? JSON.stringify(view.zoom.region) : "none"}`);
    history.push({ role: "user", text: message }, { role: "assistant", text: reply });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
