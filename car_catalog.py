"""A realistic used-car dealer inventory, shaped to Vox's Moss schema.

Cars map perfectly onto our existing data model — and better than apparel, because
each unit is UNIQUE and PERISHABLE (one VIN, one price, one mileage; when it sells
it's gone). That's exactly why real-time grounding (Moss) is the whole product:
hallucinating "yes we have it!" on a $40k purchase torches the deal.

  variant_id -> VIN          (the unique, perishable unit)
  product_id -> make+model   (so dedup keeps variety across models, not trims)
  title      -> "2022 Honda CR-V"
  variant    -> "EX-L AWD · Blue"
  price/available/image/url + opt_* (mileage, drivetrain, body, fuel, color)

The blurb each car embeds is written for SEMANTIC search — "AWD SUV for a family",
"fuel-efficient commuter", "fun first car", "truck for towing" should all hit.
"""
from __future__ import annotations

from dataclasses import dataclass, field

DEALER = "Bay Area Auto"


@dataclass
class Car:
    vin: str
    year: int
    make: str
    model: str
    trim: str
    body: str            # SUV, Sedan, Truck, Hatchback, Coupe, Minivan, EV
    drivetrain: str      # FWD, AWD, RWD, 4WD
    fuel: str            # Gas, Hybrid, Electric
    mileage: int
    price: int
    color: str
    mpg: str             # "28 city / 34 hwy" or "Electric"
    features: list[str] = field(default_factory=list)
    blurb: str = ""      # one human line about who it's for
    available: bool = True

    @property
    def title(self) -> str:
        return f"{self.year} {self.make} {self.model}"

    @property
    def variant(self) -> str:
        miles = f"{round(self.mileage/1000)}k mi"
        return f"{self.trim} · {self.drivetrain} · {miles} · {self.color}"

    def to_text(self) -> str:
        """What Moss embeds — tuned for semantic, intent-style queries."""
        feats = ", ".join(self.features)
        return (
            f"{self.year} {self.make} {self.model} {self.trim}, {self.body}, "
            f"{self.drivetrain}, {self.fuel}. {self.mileage:,} miles, {self.color}. "
            f"{self.mpg}. Features: {feats}. {self.blurb} Price ${self.price:,}."
        )

    def to_metadata(self) -> dict:
        """Moss metadata must be strings. Mirrors the apparel schema so the brain,
        cards, and sold-out-vanish all work unchanged."""
        return {
            "product_id": f"{self.make}-{self.model}".lower().replace(" ", "-"),
            "variant_id": self.vin,
            "title": self.title,
            "variant": self.variant,
            "price": str(self.price),
            "available": "true" if self.available else "false",
            "handle": self.vin,
            "image": "",  # TODO: wire real listing photos for the live demo
            "url": f"https://example-dealer.com/vin/{self.vin}",
            "opt_year": str(self.year),
            "opt_make": self.make,
            "opt_model": self.model,
            "opt_trim": self.trim,
            "opt_body": self.body,
            "opt_drivetrain": self.drivetrain,
            "opt_fuel": self.fuel,
            "opt_mileage": str(self.mileage),
            "opt_color": self.color,
            "opt_mpg": self.mpg,
        }


def _vin(n: int) -> str:
    """A stable, fake-but-VIN-shaped id (17 chars)."""
    base = f"VOX{n:05d}"
    return (base + "0000000000000000")[:17].upper()


# A believable ~36-unit lot: SUVs, sedans, trucks, hybrids, a couple EVs, a luxury
# row, and entry-level first cars. Hand-curated so the demo narrative is controllable
# (there IS a blue AWD CR-V under $30k for the Sarah story).
_RAW = [
    # --- Family / compact SUVs (the bread and butter) ---
    dict(year=2022, make="Honda", model="CR-V", trim="EX-L", body="SUV", drivetrain="AWD", fuel="Gas",
         mileage=28400, price=28400, color="Blue", mpg="28 city / 34 hwy",
         features=["Apple CarPlay", "Heated seats", "Adaptive cruise", "Backup camera"],
         blurb="Roomy, reliable compact SUV that's perfect for a growing family."),
    dict(year=2021, make="Toyota", model="RAV4", trim="XLE", body="SUV", drivetrain="AWD", fuel="Gas",
         mileage=33100, price=27900, color="Silver", mpg="27 city / 34 hwy",
         features=["Apple CarPlay", "Lane assist", "Sunroof", "Blind-spot monitor"],
         blurb="The benchmark compact SUV — bulletproof reliability and great resale."),
    dict(year=2023, make="Toyota", model="RAV4 Hybrid", trim="XSE", body="SUV", drivetrain="AWD", fuel="Hybrid",
         mileage=18700, price=34200, color="White", mpg="41 city / 38 hwy",
         features=["Hybrid", "Apple CarPlay", "Sunroof", "Power liftgate"],
         blurb="Hybrid efficiency with AWD grip — sips fuel on the commute."),
    dict(year=2020, make="Mazda", model="CX-5", trim="Touring", body="SUV", drivetrain="AWD", fuel="Gas",
         mileage=41200, price=23800, color="Red", mpg="25 city / 31 hwy",
         features=["Leather", "Apple CarPlay", "Bose audio", "Heated seats"],
         blurb="The fun-to-drive, premium-feeling SUV in this price range."),
    dict(year=2019, make="Subaru", model="Outback", trim="Premium", body="SUV", drivetrain="AWD", fuel="Gas",
         mileage=52000, price=21500, color="Green", mpg="26 city / 33 hwy",
         features=["AWD", "Roof rails", "Apple CarPlay", "Heated seats"],
         blurb="Adventure-ready wagon-SUV — great for road trips and bad weather."),
    # --- Efficient commuter sedans ---
    dict(year=2021, make="Honda", model="Civic", trim="EX", body="Sedan", drivetrain="FWD", fuel="Gas",
         mileage=29500, price=22400, color="Gray", mpg="32 city / 42 hwy",
         features=["Apple CarPlay", "Sunroof", "Adaptive cruise", "Lane assist"],
         blurb="Efficient, fun, and dead-reliable — a perfect commuter or first car."),
    dict(year=2020, make="Toyota", model="Corolla", trim="LE", body="Sedan", drivetrain="FWD", fuel="Gas",
         mileage=38800, price=18900, color="White", mpg="30 city / 38 hwy",
         features=["Apple CarPlay", "Backup camera", "Lane assist"],
         blurb="The safe, cheap-to-own first car that just won't quit."),
    dict(year=2022, make="Honda", model="Accord", trim="Sport", body="Sedan", drivetrain="FWD", fuel="Gas",
         mileage=24100, price=27600, color="Black", mpg="29 city / 37 hwy",
         features=["Leather", "Apple CarPlay", "Sunroof", "Wireless charging"],
         blurb="Roomy, sharp-looking midsize sedan that drives younger than it is."),
    dict(year=2019, make="Hyundai", model="Elantra", trim="SEL", body="Sedan", drivetrain="FWD", fuel="Gas",
         mileage=47300, price=15400, color="Silver", mpg="31 city / 40 hwy",
         features=["Apple CarPlay", "Backup camera", "Heated seats"],
         blurb="Budget-friendly, great-warranty commuter with low miles for the year."),
    # --- Hybrids / efficiency hunters ---
    dict(year=2021, make="Toyota", model="Prius", trim="LE", body="Hatchback", drivetrain="FWD", fuel="Hybrid",
         mileage=31000, price=24200, color="Blue", mpg="54 city / 50 hwy",
         features=["Hybrid", "Apple CarPlay", "Lane assist", "Adaptive cruise"],
         blurb="The fuel-economy king — over 50 mpg for the brutal commute."),
    dict(year=2022, make="Honda", model="CR-V Hybrid", trim="EX", body="SUV", drivetrain="AWD", fuel="Hybrid",
         mileage=22600, price=31200, color="Gray", mpg="40 city / 35 hwy",
         features=["Hybrid", "AWD", "Apple CarPlay", "Heated seats"],
         blurb="Family SUV space with hybrid mpg and all-wheel-drive confidence."),
    # --- Trucks (towing / work) ---
    dict(year=2020, make="Ford", model="F-150", trim="XLT", body="Truck", drivetrain="4WD", fuel="Gas",
         mileage=44800, price=33900, color="Black", mpg="19 city / 24 hwy",
         features=["Tow package", "4WD", "Crew cab", "Apple CarPlay"],
         blurb="Half-ton workhorse — tows ~11k lbs, crew cab room for the whole crew."),
    dict(year=2021, make="Toyota", model="Tacoma", trim="TRD Off-Road", body="Truck", drivetrain="4WD", fuel="Gas",
         mileage=36500, price=36400, color="Silver", mpg="20 city / 23 hwy",
         features=["4WD", "Tow package", "Off-road suspension", "Crawl control"],
         blurb="The do-anything midsize truck with legendary resale and trail chops."),
    dict(year=2019, make="Ram", model="1500", trim="Big Horn", body="Truck", drivetrain="4WD", fuel="Gas",
         mileage=49200, price=29800, color="Gray", mpg="17 city / 23 hwy",
         features=["Tow package", "4WD", "Crew cab", "Heated seats"],
         blurb="Smoothest-riding full-size truck — comfy daily that still hauls."),
    # --- EVs ---
    dict(year=2022, make="Tesla", model="Model 3", trim="Long Range", body="EV", drivetrain="AWD", fuel="Electric",
         mileage=26700, price=32900, color="White", mpg="Electric ~330 mi range",
         features=["Autopilot", "AWD", "330 mi range", "Supercharging"],
         blurb="Long-range EV with AWD — fast, cheap to run, tons of tech."),
    dict(year=2021, make="Chevrolet", model="Bolt", trim="LT", body="EV", drivetrain="FWD", fuel="Electric",
         mileage=30200, price=19900, color="Blue", mpg="Electric ~259 mi range",
         features=["259 mi range", "Apple CarPlay", "One-pedal driving"],
         blurb="Affordable EV with real range — a steal for a city commuter."),
    # --- Minivan / people-movers ---
    dict(year=2020, make="Honda", model="Odyssey", trim="EX-L", body="Minivan", drivetrain="FWD", fuel="Gas",
         mileage=45600, price=28400, color="Silver", mpg="19 city / 28 hwy",
         features=["Leather", "Rear entertainment", "Power doors", "8 seats"],
         blurb="The ultimate family hauler — 8 seats, sliding doors, road-trip ready."),
    dict(year=2021, make="Toyota", model="Sienna", trim="XLE", body="Minivan", drivetrain="AWD", fuel="Hybrid",
         mileage=34900, price=37200, color="Gray", mpg="36 city / 36 hwy",
         features=["Hybrid", "AWD", "8 seats", "Power doors"],
         blurb="Hybrid AWD minivan — 36 mpg with room for the whole team."),
    # --- Luxury row ---
    dict(year=2020, make="BMW", model="3 Series", trim="330i", body="Sedan", drivetrain="RWD", fuel="Gas",
         mileage=39800, price=29900, color="Black", mpg="26 city / 36 hwy",
         features=["Leather", "Sunroof", "Premium audio", "Heated seats"],
         blurb="The driver's sport sedan — luxury feel, athletic handling."),
    dict(year=2019, make="Lexus", model="RX 350", trim="Base", body="SUV", drivetrain="AWD", fuel="Gas",
         mileage=43100, price=32600, color="White", mpg="20 city / 27 hwy",
         features=["Leather", "AWD", "Sunroof", "Premium audio"],
         blurb="Whisper-quiet luxury SUV with Lexus reliability and resale."),
    dict(year=2021, make="Audi", model="Q5", trim="Premium Plus", body="SUV", drivetrain="AWD", fuel="Gas",
         mileage=31700, price=35900, color="Blue", mpg="23 city / 28 hwy",
         features=["Leather", "Virtual cockpit", "AWD", "Panoramic roof"],
         blurb="Tech-forward luxury crossover that feels brand new inside."),
    # --- Sporty / fun ---
    dict(year=2020, make="Ford", model="Mustang", trim="GT", body="Coupe", drivetrain="RWD", fuel="Gas",
         mileage=27800, price=33400, color="Red", mpg="15 city / 24 hwy",
         features=["V8", "Performance package", "Leather", "Premium audio"],
         blurb="460-hp V8 muscle — the fun-on-a-weekend car you've always wanted."),
    dict(year=2021, make="Mazda", model="MX-5 Miata", trim="Club", body="Coupe", drivetrain="RWD", fuel="Gas",
         mileage=19400, price=28900, color="Red", mpg="26 city / 34 hwy",
         features=["Convertible", "Manual", "Bose audio", "Low miles"],
         blurb="The purest, most fun-per-dollar roadster on the road."),
    # --- Entry-level / first cars ---
    dict(year=2018, make="Honda", model="Fit", trim="LX", body="Hatchback", drivetrain="FWD", fuel="Gas",
         mileage=58200, price=13900, color="Blue", mpg="33 city / 40 hwy",
         features=["Apple CarPlay", "Backup camera", "Magic seats"],
         blurb="Tiny on the outside, huge on the inside — a perfect cheap first car."),
    dict(year=2019, make="Kia", model="Soul", trim="Plus", body="Hatchback", drivetrain="FWD", fuel="Gas",
         mileage=44100, price=15600, color="White", mpg="27 city / 33 hwy",
         features=["Apple CarPlay", "Backup camera", "Roomy cargo"],
         blurb="Funky, practical, and cheap to run — great new-driver pick."),
    dict(year=2017, make="Toyota", model="Camry", trim="SE", body="Sedan", drivetrain="FWD", fuel="Gas",
         mileage=61500, price=16200, color="Gray", mpg="24 city / 33 hwy",
         features=["Backup camera", "Bluetooth", "Alloy wheels"],
         blurb="High miles but Camry-reliable — budget midsize that'll run forever."),
    # --- A few more SUVs for depth ---
    dict(year=2022, make="Hyundai", model="Tucson", trim="SEL", body="SUV", drivetrain="AWD", fuel="Gas",
         mileage=21300, price=26700, color="Gray", mpg="24 city / 29 hwy",
         features=["Apple CarPlay", "AWD", "Heated seats", "Long warranty"],
         blurb="Bold-looking compact SUV with low miles and warranty left."),
    dict(year=2020, make="Jeep", model="Grand Cherokee", trim="Limited", body="SUV", drivetrain="4WD", fuel="Gas",
         mileage=46900, price=28200, color="Black", mpg="18 city / 25 hwy",
         features=["Leather", "4WD", "Tow package", "Sunroof"],
         blurb="Capable, comfortable 4WD SUV that tows and goes anywhere."),
    dict(year=2021, make="Ford", model="Explorer", trim="XLT", body="SUV", drivetrain="AWD", fuel="Gas",
         mileage=37400, price=30900, color="Silver", mpg="21 city / 28 hwy",
         features=["3rd row", "AWD", "Apple CarPlay", "Tow package"],
         blurb="3-row family SUV with space for seven and gear for the trip."),
    dict(year=2019, make="Chevrolet", model="Equinox", trim="LT", body="SUV", drivetrain="FWD", fuel="Gas",
         mileage=51200, price=18700, color="Red", mpg="26 city / 31 hwy",
         features=["Apple CarPlay", "Backup camera", "Heated seats"],
         blurb="Affordable, easy compact SUV — a sensible budget family pick."),
    dict(year=2023, make="Kia", model="Telluride", trim="EX", body="SUV", drivetrain="AWD", fuel="Gas",
         mileage=15800, price=41300, color="Black", mpg="19 city / 24 hwy",
         features=["3rd row", "Leather", "AWD", "Captain's chairs"],
         blurb="The award-winning 3-row — nearly new and almost impossible to find."),
    dict(year=2020, make="Volkswagen", model="Tiguan", trim="SE", body="SUV", drivetrain="AWD", fuel="Gas",
         mileage=42800, price=22100, color="White", mpg="21 city / 28 hwy",
         features=["3rd row", "Apple CarPlay", "AWD", "Panoramic roof"],
         blurb="Roomy 3-row-capable compact SUV with a premium German feel."),
    dict(year=2018, make="Nissan", model="Rogue", trim="SV", body="SUV", drivetrain="AWD", fuel="Gas",
         mileage=57600, price=16900, color="Gray", mpg="25 city / 32 hwy",
         features=["Apple CarPlay", "AWD", "Backup camera"],
         blurb="Comfortable, affordable AWD SUV — a lot of space for the money."),
    dict(year=2022, make="Subaru", model="Forester", trim="Premium", body="SUV", drivetrain="AWD", fuel="Gas",
         mileage=24900, price=27300, color="Green", mpg="26 city / 33 hwy",
         features=["AWD", "EyeSight safety", "Sunroof", "Roof rails"],
         blurb="Safe, practical, great-visibility AWD SUV families love."),
    dict(year=2021, make="Tesla", model="Model Y", trim="Long Range", body="EV", drivetrain="AWD", fuel="Electric",
         mileage=29800, price=36800, color="White", mpg="Electric ~326 mi range",
         features=["Autopilot", "AWD", "326 mi range", "Glass roof"],
         blurb="The do-it-all electric SUV — space, range, and AWD."),
    # --- The halo car (the one the salesman sells in the demo) + performance peers ---
    dict(year=2022, make="Porsche", model="911 GT3", trim="GT3", body="Coupe", drivetrain="RWD", fuel="Gas",
         mileage=4200, price=219900, color="Shark Blue", mpg="14 city / 18 hwy",
         features=["502-hp 4.0L naturally-aspirated flat-six", "6-speed manual", "Carbon-ceramic brakes",
                   "Clubsport package w/ roll cage", "Carbon bucket seats", "Front-axle lift", "Track-ready"],
         blurb="A street-legal track weapon — the naturally aspirated, 9,000-rpm enthusiast's dream, "
               "barely broken in at 4,200 miles."),
    dict(year=2021, make="Chevrolet", model="Corvette Stingray", trim="2LT", body="Coupe", drivetrain="RWD", fuel="Gas",
         mileage=11800, price=78900, color="Torch Red", mpg="15 city / 27 hwy",
         features=["495-hp 6.2L V8", "Mid-engine", "Magnetic Ride Control", "Performance exhaust", "Carbon trim"],
         blurb="Mid-engine supercar performance and looks for a fraction of the exotic price."),
    dict(year=2020, make="Porsche", model="718 Cayman", trim="S", body="Coupe", drivetrain="RWD", fuel="Gas",
         mileage=18600, price=62400, color="GT Silver", mpg="20 city / 26 hwy",
         features=["350-hp turbo flat-four", "PDK", "Sport Chrono", "Bose surround"],
         blurb="The perfectly balanced mid-engine sports car — a pure driver's machine."),
]


def inventory() -> list[Car]:
    cars = []
    for i, d in enumerate(_RAW, 1):
        cars.append(Car(vin=_vin(i), **d))
    return cars


_BY_VIN = {c.vin: c for c in inventory()}


def by_vin(vin: str) -> Car | None:
    return _BY_VIN.get(vin)


if __name__ == "__main__":
    cars = inventory()
    print(f"{len(cars)} cars at {DEALER}\n")
    for c in cars[:5]:
        print(f"  [{c.vin}] {c.title} — {c.variant} — ${c.price:,} — {c.mileage:,} mi")
        print(f"      {c.to_text()}\n")
