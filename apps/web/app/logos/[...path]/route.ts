import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

const LOGOS_ROOT = path.resolve(process.cwd(), "../../public/logos");

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await context.params;
  const filePath = path.resolve(LOGOS_ROOT, ...parts);

  if (!filePath.startsWith(`${LOGOS_ROOT}${path.sep}`)) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const bytes = await readFile(filePath);
    const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    return new NextResponse(bytes, {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": contentType
      }
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
