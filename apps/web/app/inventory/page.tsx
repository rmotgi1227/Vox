"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ImageIcon, Mic } from "lucide-react";
import { DEFAULT_VIN } from "@vox/core";
import { getInventory, type InventoryCar } from "@/lib/api";

// Only BMW-M4 has the live voice specialist (the /specialist page is BMW-only).
// Every other car opens its static detail page.
const SPECIALIST_VINS = new Set([DEFAULT_VIN]);

function CarCard({ car }: { car: InventoryCar }) {
  const [imgOk, setImgOk] = useState(true);
  const hero = car.photos[0];
  const isFeatured = SPECIALIST_VINS.has(car.vin);
  const href = isFeatured ? "/specialist" : `/inventory/${encodeURIComponent(car.vin)}`;

  return (
    <Link href={href} className="group block overflow-hidden rounded-2xl border border-black/10 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-neutral-100">
        {hero && imgOk ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={hero} alt={`${car.year} ${car.make} ${car.model}`} className="h-full w-full object-cover transition duration-300 group-hover:scale-105" onError={() => setImgOk(false)} />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-neutral-300"><ImageIcon size={48} /></div>
        )}
        {isFeatured ? (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-black px-2.5 py-1 text-xs font-semibold text-white">
            <Mic size={12} /> Talk to a specialist
          </span>
        ) : null}
      </div>
      <div className="p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="truncate text-base font-semibold text-neutral-900">{car.year} {car.make} {car.model}</h3>
          <span className="shrink-0 text-base font-semibold text-neutral-900">{car.price != null ? `$${car.price.toLocaleString()}` : "Inquire"}</span>
        </div>
        <p className="mt-0.5 truncate text-sm text-neutral-500">{car.trim}</p>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-500">
          <span>{car.mileage.toLocaleString()} mi</span>
          <span>·</span>
          <span>{car.drivetrain}</span>
          <span>·</span>
          <span>{car.fuel}</span>
          <span>·</span>
          <span>{car.body}</span>
        </div>
      </div>
    </Link>
  );
}

export default function InventoryPage() {
  const [cars, setCars] = useState<InventoryCar[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getInventory().then(setCars).catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load inventory"));
  }, []);

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <header className="mb-8 flex items-end justify-between border-b border-black/10 pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-neutral-900">Vox Motors</h1>
          <p className="mt-1 text-sm text-neutral-500">Pre-owned inventory{cars ? ` · ${cars.length} vehicles available` : ""}</p>
        </div>
        <Link href="/specialist" className="hidden rounded-full bg-black px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-800 sm:inline-flex sm:items-center sm:gap-2">
          <Mic size={15} /> Talk to a specialist
        </Link>
      </header>

      {error ? <p className="text-sm text-red-600">Error: {error}</p> : null}

      {!cars && !error ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="animate-pulse overflow-hidden rounded-2xl border border-black/10 bg-white">
              <div className="aspect-[4/3] w-full bg-neutral-100" />
              <div className="space-y-2 p-4"><div className="h-4 w-2/3 rounded bg-neutral-100" /><div className="h-3 w-1/3 rounded bg-neutral-100" /></div>
            </div>
          ))}
        </div>
      ) : null}

      {cars ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {cars.map((car) => <CarCard key={car.vin} car={car} />)}
        </div>
      ) : null}
    </main>
  );
}
