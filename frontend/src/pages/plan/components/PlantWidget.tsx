// A small living plant that reflects how today is going — the Plan page's
// progress meter. Complete habits and it grows toward "flourishing"; miss them
// and it wilts. Per the app's spirit (and Jennifer's mom's plant) it never
// truly dies: "wilting" is the floor, and it recovers the moment the day does.
// State is DERIVED from today's counts — nothing is stored.

export type PlantState = "wilting" | "steady" | "flourishing";

// Today's plant health from the day's tallies. Pending habits don't wilt it (a
// fresh morning is "steady", not dying); only actual misses pull it down, and
// completions grow it. Thresholds are intentionally simple so they're easy to
// tune later.
export function plantState(
  done: number,
  missed: number,
  total: number,
): PlantState {
  if (total === 0) return "steady";
  if (missed / total >= 0.5) return "wilting";
  if (done / total >= 0.6) return "flourishing";
  return "steady";
}

// Glow strength grows with health — a soft sage halo behind the pot.
const GLOW: Record<PlantState, string> = {
  wilting:
    "radial-gradient(circle at 50% 44%, rgba(123,171,154,.10), transparent 70%)",
  steady:
    "radial-gradient(circle at 50% 42%, rgba(123,171,154,.18), transparent 70%)",
  flourishing:
    "radial-gradient(circle at 50% 40%, rgba(123,171,154,.28), transparent 72%)",
};

// The pot is shared by every state; only the foliage above it changes.
function Pot() {
  return (
    <>
      <path
        d="M22 47 L42 47 L40 60 Q32 62.5 24 60 Z"
        fill="#fff"
        stroke="#dfeee6"
        strokeWidth={1.5}
      />
      <rect
        x={20}
        y={44}
        width={24}
        height={5}
        rx={2.5}
        fill="#f2f8f5"
        stroke="#dfeee6"
        strokeWidth={1}
      />
      <ellipse cx={32} cy={47.5} rx={8} ry={1.5} fill="#3e5a4e" opacity={0.4} />
    </>
  );
}

function Foliage({ state }: { state: PlantState }) {
  if (state === "wilting") {
    // Drooping, muted leaves; a single closed bud and one fallen petal.
    return (
      <>
        <path
          d="M32 47 Q30 33 33 22"
          fill="none"
          stroke="#7d968b"
          strokeWidth={2.2}
          strokeLinecap="round"
        />
        <ellipse cx={23} cy={40} rx={6.6} ry={3} fill="#9fb7ac" transform="rotate(26 23 40)" />
        <ellipse cx={41} cy={37} rx={6.6} ry={3} fill="#9fb7ac" transform="rotate(-26 41 37)" />
        <ellipse cx={26} cy={31} rx={6} ry={2.7} fill="#aecabd" transform="rotate(18 26 31)" />
        <ellipse cx={33.5} cy={20} rx={2.4} ry={3.8} fill="#c9c0d8" transform="rotate(8 33.5 20)" />
        <circle cx={24} cy={59} r={1.6} fill="#c4b3e0" opacity={0.65} />
      </>
    );
  }
  if (state === "flourishing") {
    // Upright, full leaves; open lilac blooms.
    return (
      <>
        <path
          d="M32 46 Q31 29 32 15"
          fill="none"
          stroke="#2d4a44"
          strokeWidth={2.4}
          strokeLinecap="round"
        />
        <ellipse cx={24} cy={36} rx={7.4} ry={3.3} fill="#5a8f7b" transform="rotate(-28 24 36)" />
        <ellipse cx={40} cy={32} rx={7.4} ry={3.3} fill="#5a8f7b" transform="rotate(28 40 32)" />
        <ellipse cx={25} cy={27} rx={7} ry={3.1} fill="#7bab9a" transform="rotate(-33 25 27)" />
        <ellipse cx={39} cy={24} rx={6.6} ry={3} fill="#7bab9a" transform="rotate(33 39 24)" />
        <circle cx={30} cy={13.5} r={1.9} fill="#c4b3e0" />
        <circle cx={34} cy={13.5} r={1.9} fill="#c4b3e0" />
        <circle cx={30} cy={16.8} r={1.9} fill="#c4b3e0" />
        <circle cx={34} cy={16.8} r={1.9} fill="#c4b3e0" />
        <circle cx={32} cy={15.1} r={1.3} fill="#f4efe8" />
      </>
    );
  }
  // steady — healthy, calm, a couple of buds.
  return (
    <>
      <path
        d="M32 46 Q31 30 32 17"
        fill="none"
        stroke="#2d4a44"
        strokeWidth={2.3}
        strokeLinecap="round"
      />
      <ellipse cx={24} cy={37} rx={7.2} ry={3.2} fill="#5a8f7b" transform="rotate(-27 24 37)" />
      <ellipse cx={40} cy={34} rx={7.2} ry={3.2} fill="#5a8f7b" transform="rotate(27 40 34)" />
      <ellipse cx={25} cy={28} rx={6.6} ry={3} fill="#7bab9a" transform="rotate(-32 25 28)" />
      <circle cx={31} cy={16.5} r={1.7} fill="#c4b3e0" />
      <circle cx={34.5} cy={16.5} r={1.7} fill="#c4b3e0" />
    </>
  );
}

export default function PlantWidget({
  done,
  total,
  missed = 0,
  size = 68,
}: {
  done: number;
  total: number;
  missed?: number;
  size?: number;
}) {
  const state = plantState(done, missed, total);
  const label =
    total === 0
      ? "Your plant is resting — nothing scheduled today"
      : `Your plant is ${state} — ${done} of ${total} done today`;

  return (
    <div className="relative grid place-items-center">
      <div
        aria-hidden
        className="pointer-events-none absolute"
        style={{ inset: "-16px -34px", background: GLOW[state] }}
      />
      <svg
        aria-hidden
        viewBox="0 0 64 66"
        width={size}
        height={size}
        className="relative"
      >
        <Foliage state={state} />
        <Pot />
      </svg>
      <span className="sr-only">{label}</span>
    </div>
  );
}
