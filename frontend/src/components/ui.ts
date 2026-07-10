// The app-wide surface recipes, so every page draws cards and controls the
// same way. Colors come from the named palette in index.css (mist, whisper,
// petal, lilac, ink).

// A card: white, 18px corners, a 1px mist border with a breath of shadow.
export const CARD =
  "rounded-[18px] border border-mist bg-white shadow-[0_1px_2px_rgba(27,46,42,0.04)]";

// A segmented pill (Roots/Growth, Main/All, ...): a white pill whose active
// option sits in a mint well.
export const SEG = "inline-flex rounded-full border border-mist bg-white p-0.5";
export const segOption = (active: boolean) =>
  `rounded-full px-3 py-1 text-xs transition-colors ${
    active
      ? "bg-mint font-semibold text-calm-700"
      : "font-medium text-stone-400 hover:text-stone-600"
  }`;

// Aspiration "garden bed" colors: every aspiration wears one bloom color,
// assigned by id (stable everywhere it appears — its card's top edge on the
// Aspirations page and its dot next to member habits). Six garden hues so new
// aspirations keep getting distinct colors. The ORDER is deliberate: slots
// 1/2/3 match what ids 1 (Walk more, green), 2 (Talk better, clay) and
// 3 (Sleep better, lilac) already wore under the old 3-color rotation — don't
// reshuffle, or existing beds change color under her.
export const BLOOMS = [
  { edge: "#dcae63", dot: "#cf9d4a" }, // marigold
  { edge: "#47a183", dot: "#47a183" }, // leaf green
  { edge: "#d9a79e", dot: "#c98f83" }, // clay
  { edge: "#ad8fe0", dot: "#ad8fe0" }, // lilac
  { edge: "#dfa0b4", dot: "#d98fa6" }, // rose
  { edge: "#9fb6de", dot: "#8aa8d8" }, // sky
] as const;
// The bloom an aspiration wears. `colorIndex` (0-5) is the user's chosen color;
// when it's null/undefined we fall back to the id-based default so untouched
// aspirations keep their original hue.
export const bloomFor = (aspirationId: number, colorIndex?: number | null) =>
  BLOOMS[
    (((colorIndex ?? aspirationId) % BLOOMS.length) + BLOOMS.length) %
      BLOOMS.length
  ];

// The primary action pill that sits on a page header's baseline ("+ New").
export const HEADER_ACTION =
  "shrink-0 rounded-full bg-calm-600 px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-calm-700";

// A quiet secondary chip for a header's baseline ("Edit").
export const HEADER_CHIP =
  "shrink-0 rounded-full border border-mist bg-white px-4 py-1.5 text-[13px] font-semibold text-calm-700 transition-colors hover:bg-whisper";

// Form recipe: a small-caps green label over a whisper inset field, one
// full-width pill to save. Forms group their fields inside one CARD.
export const F_LABEL =
  "block text-[10.5px] font-semibold uppercase tracking-[0.12em] text-calm-600 mb-1.5";
export const F_INPUT =
  "w-full rounded-xl border border-mist bg-whisper px-3.5 py-3 text-sm text-ink placeholder:text-stone-400 focus:border-calm-400 focus:outline-none";
export const BTN_PRIMARY =
  "w-full rounded-full bg-calm-600 py-3.5 text-sm font-semibold text-white transition hover:bg-calm-700 active:scale-[0.99] disabled:opacity-60";

// The serif title line inside a card ("Tiers", "Notes").
export const CARD_TITLE = "font-heading text-lg font-medium text-ink";
