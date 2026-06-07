import type { Car, CarImage, ConversationTurn, ModelProfileId, SpecialistState, SpecialistTurn } from "@vox/core";

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export async function getSpecialistState(vin: string): Promise<SpecialistState> {
  const res = await fetch(`${API_BASE}/api/specialist/state?vin=${encodeURIComponent(vin)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`State failed: ${res.status}`);
  return res.json();
}

export async function sendSpecialistMessage(input: {
  vin: string;
  message: string;
  currentImageId?: string;
  includeAudio?: boolean;
  deferImage?: boolean;
  history?: ConversationTurn[];
}): Promise<SpecialistTurn & { audioBase64?: string; provider?: string; needsImage?: boolean; desiredVisualTarget?: string | null }> {
  const res = await fetch(`${API_BASE}/api/specialist/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(`Message failed: ${res.status}`);
  return res.json();
}

export async function selectSpecialistImage(input: {
  vin: string;
  message: string;
  currentImageId?: string;
  desiredVisualTarget?: string | null;
}): Promise<SpecialistTurn> {
  const res = await fetch(`${API_BASE}/api/specialist/image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(`Image failed: ${res.status}`);
  return res.json();
}

export async function getLiveKitToken(input: { roomName: string; identity: string; profileId?: ModelProfileId; returning?: boolean; brainMode?: "single" | "double" }): Promise<{ token: string; url: string; roomName: string }> {
  const res = await fetch(`${API_BASE}/api/livekit/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ? `LiveKit failed: ${detail.error}` : `LiveKit failed: ${res.status}`);
  }
  return res.json();
}

export async function listAdminImages(vin: string): Promise<CarImage[]> {
  const res = await fetch(`${API_BASE}/api/admin/images?vin=${encodeURIComponent(vin)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Images failed: ${res.status}`);
  const data = await res.json();
  return data.images;
}

export async function uploadImages(vin: string, files: FileList): Promise<CarImage[]> {
  const body = new FormData();
  body.set("vin", vin);
  Array.from(files).forEach((file, i) => body.set(`file_${i}`, file));
  const res = await fetch(`${API_BASE}/api/admin/images/upload`, { method: "POST", body });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const data = await res.json();
  return data.images;
}

export async function ingestImage(id: string): Promise<CarImage> {
  const res = await fetch(`${API_BASE}/api/admin/images/${encodeURIComponent(id)}/ingest`, { method: "POST" });
  if (!res.ok) throw new Error(`Ingest failed: ${res.status}`);
  const data = await res.json();
  return data.image;
}

export type MossConfig = {
  projectId: string;
  projectKey: string;
  catalogIndex: string | null;
  imagesIndex: string | null;
};

// Browser Moss config — credentials + index names for in-browser @inferedge/moss.
export async function getMossConfig(): Promise<MossConfig> {
  const res = await fetch(`${API_BASE}/api/moss/config`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Moss config failed: ${res.status}`);
  return res.json();
}

export type SoldResult = {
  car: Car;
  alternative: { vin: string; title: string; price?: string; body?: string } | null;
};

// Mark a car sold (server persists availability=sold; agent picks it up next turn).
export async function markCarSold(vin: string): Promise<SoldResult> {
  const res = await fetch(`${API_BASE}/api/specialist/sold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vin })
  });
  if (!res.ok) throw new Error(`Mark sold failed: ${res.status}`);
  return res.json();
}

// Mint a short-lived Simli avatar session token (browser renders the talking head).
export async function getAvatarToken(): Promise<{ sessionToken?: string; faceId?: string; iceServers?: unknown[] }> {
  const res = await fetch(`${API_BASE}/api/avatar/token`, { method: "POST" });
  if (!res.ok) throw new Error(`Avatar token failed: ${res.status}`);
  return res.json();
}
