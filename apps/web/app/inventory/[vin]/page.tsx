"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ImageIcon } from "lucide-react";
import type { Car } from "@vox/core";
import { getCarDetail } from "@/lib/api";

export default function CarDetailPage() {
  const params = useParams<{ vin: string }>();
  const vin = decodeURIComponent(params.vin);
  const [data, setData] = useState<{ car: Car; photos: string[] } | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    getCarDetail(vin).then((d) => { setData(d); setActive(0); }).catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, [vin]);

  if (error) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900"><ArrowLeft size={15} /> Back to inventory</Link>
        <p className="mt-6 text-sm text-red-600">Error: {error}</p>
      </main>
    );
  }
  if (!data) {
    return <main className="mx-auto max-w-5xl px-6 py-10 text-sm text-neutral-400">Loading…</main>;
  }

  const { car, photos } = data;
  const hero = photos[active];
  const spec: [string, string | number][] = [
    ["Trim", car.trim], ["Body", car.body], ["Drivetrain", car.drivetrain], ["Fuel", car.fuel],
    ["Mileage", `${car.mileage.toLocaleString()} mi`], ["Color", car.color], ["Availability", car.availability]
  ];
  if (car.specs) {
    spec.push(["Engine", car.specs.engine], ["Horsepower", `${car.specs.horsepower} hp`], ["0–60", `${car.specs.zeroToSixtySeconds}s`], ["MPG", `${car.specs.mpgCity}/${car.specs.mpgHighway}`], ["Seats", car.specs.seating]);
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <Link href="/" className="mb-6 inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900"><ArrowLeft size={15} /> Back to inventory</Link>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.4fr_1fr]" style={{ minWidth: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div className="rounded-2xl bg-neutral-100" style={{ aspectRatio: "4 / 3", width: "100%", overflow: "hidden", borderRadius: 16 }}>
            {hero ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={hero} alt={`${car.year} ${car.make} ${car.model}`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-neutral-300"><ImageIcon size={56} /></div>
            )}
          </div>
          {photos.length > 1 ? (
            <div className="mt-3 flex gap-2 overflow-x-auto">
              {photos.map((p, i) => (
                <button key={p} type="button" onClick={() => setActive(i)} className={`shrink-0 overflow-hidden rounded-lg border ${i === active ? "border-black" : "border-black/10"}`} style={{ width: 96, height: 64 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900">{car.year} {car.make} {car.model}</h1>
          <p className="mt-1 text-lg font-semibold text-neutral-900">{car.price != null ? `$${car.price.toLocaleString()}` : "Inquire for price"}</p>
          {car.availability === "available" ? <span className="mt-2 inline-block rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">Available</span> : null}

          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-black/10 pt-6">
            {spec.map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs uppercase tracking-wide text-neutral-400">{k}</dt>
                <dd className="text-sm font-medium text-neutral-900">{v}</dd>
              </div>
            ))}
          </dl>

          <button type="button" className="mt-6 w-full rounded-full bg-black px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800">Inquire about this vehicle</button>
        </div>
      </div>

      {car.features.length ? (
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Features</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {car.features.map((f) => <span key={f} className="rounded-full bg-neutral-100 px-3 py-1 text-sm text-neutral-700">{f}</span>)}
          </div>
        </section>
      ) : null}

      {car.description ? (
        <section className="mt-8 max-w-3xl">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">About this vehicle</h2>
          <p className="mt-3 leading-relaxed text-neutral-700">{car.description}</p>
        </section>
      ) : null}
    </main>
  );
}
