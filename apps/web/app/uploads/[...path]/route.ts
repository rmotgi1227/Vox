import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

// Serves user-uploaded + agent-generated images that live in the repo-root
// public/uploads dir (e.g. Nano Banana visualizations: /uploads/cars/<vin>/gen_*.png).
// Mirrors the /cars route — generated files are written there by @vox/ai
// generateVisualization, which the Next static handler (apps/web/public) can't see.
const UPLOADS_ROOT = path.resolve(process.cwd(), "../../public/uploads");

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await context.params;
  const filePath = path.resolve(UPLOADS_ROOT, ...parts);

  if (!filePath.startsWith(`${UPLOADS_ROOT}${path.sep}`)) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const bytes = await readFile(filePath);
    const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    return new NextResponse(bytes, {
      headers: {
        // Generated images are unique per id, but don't cache as hard as catalog
        // photos — a regeneration could reuse a path in dev.
        "Cache-Control": "public, max-age=3600",
        "Content-Type": contentType
      }
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
