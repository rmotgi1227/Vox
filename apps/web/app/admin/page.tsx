"use client";

import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import type { CarImage } from "@vox/core";
import { DEFAULT_VIN } from "@vox/core";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ingestImage, listAdminImages, uploadImages } from "@/lib/api";

export default function AdminPage() {
  const [vin, setVin] = useState(DEFAULT_VIN);
  const [images, setImages] = useState<CarImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh(nextVin = vin) {
    setImages(await listAdminImages(nextVin));
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, []);

  async function onUpload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError("");
    try {
      await uploadImages(vin, files);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function onIngest(id: string) {
    setBusy(true);
    setError("");
    try {
      await ingestImage(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ingest failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">Vox Admin</div>
        <nav className="nav"><a href="/specialist">Specialist</a><a href="/admin">Admin</a></nav>
      </header>
      <main className="admin">
        <div>
          <h1 style={{ margin: 0 }}>Image ingestion</h1>
          <p style={{ color: "var(--muted)", marginTop: 6 }}>Upload batches, then run offline image-object ingestion. Runtime chat only reads processed objects.</p>
        </div>
        <div className="admin-grid">
          <Card>
            <label style={{ display: "grid", gap: 8 }}>
              VIN
              <Input value={vin} onChange={(e) => setVin(e.target.value)} onBlur={() => refresh().catch((err) => setError(err.message))} />
            </label>
            <div style={{ height: 14 }} />
            <label className="btn" style={{ width: "100%" }}>
              <Upload size={16} /> Upload images
              <input type="file" accept="image/*" multiple hidden onChange={(e) => onUpload(e.target.files)} disabled={busy} />
            </label>
            {error ? <p style={{ color: "#b42318" }}>{error}</p> : null}
          </Card>

          <div className="image-list">
            {images.map((image) => (
              <Card key={image.id} className="image-row">
                <img src={image.url} alt={image.caption} />
                <div>
                  <div style={{ fontWeight: 800 }}>{image.role.replaceAll("_", " ")}</div>
                  <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 3 }}>{image.caption}</div>
                  <div style={{ marginTop: 7 }}>
                    <span className={`pill ${image.status === "processed" ? "ok" : ""}`}>{image.status}</span>
                  </div>
                </div>
                <Button variant="secondary" disabled={busy} onClick={() => onIngest(image.id)}>Ingest</Button>
              </Card>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
