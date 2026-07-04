import PlantWidget from "./PlantWidget";

// Plant hero: the living progress meter — it grows with today's habits and wilts
// when the day slips — with Jennifer's quote beneath it. Behind the plant: the
// aura wall (ported from the old mock she loved) — one soft mint-into-lilac
// radial glow, no edges. Purely presentational; the day's tally comes in as props.
export function PlantHero({
  done,
  total,
  missed,
}: {
  done: number;
  total: number;
  missed: number;
}) {
  return (
    <div className="flex flex-col items-center pb-1 pt-2">
      <div className="relative grid h-[116px] w-[210px] place-items-center">
        {/* closest-side keeps the gradient fully transparent before the
            box's edges — without it the glow clips at the box top and
            leaves a faint color line above the aura. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-7 h-[170px] w-[230px]"
          style={{
            background:
              "radial-gradient(circle closest-side at 50% 45%, rgba(93,199,160,0.26) 0%, rgba(158,134,217,0.13) 45%, rgba(158,134,217,0.08) 58%, rgba(158,134,217,0.045) 68%, rgba(158,134,217,0.022) 78%, rgba(158,134,217,0.009) 88%, rgba(158,134,217,0) 100%)",
          }}
        />
        <div className="relative">
          <PlantWidget
            done={done}
            total={total}
            missed={missed}
            size={84}
            glow={false}
          />
        </div>
      </div>
      <p className="mt-2 text-center font-heading text-lg italic text-[#55695f]">
        “what if it all works out”
      </p>
    </div>
  );
}
