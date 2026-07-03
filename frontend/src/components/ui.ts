// The app-wide surface recipes, so every page draws cards and controls the
// same way. Colors come from the named palette in index.css (mist, whisper,
// petal, lilac, ink).

// A card: white, 18px corners, a 1px mist border with a breath of shadow.
export const CARD =
  "rounded-[18px] border border-mist bg-white shadow-[0_1px_2px_rgba(27,46,42,0.04)]";

// A segmented pill (Roots/Growth, Main/All, ...): a white pill whose active
// option sits in a whisper well — same treatment as the bottom nav's active tab.
export const SEG = "inline-flex rounded-full border border-mist bg-white p-0.5";
export const segOption = (active: boolean) =>
  `rounded-full px-3 py-1 text-xs transition-colors ${
    active
      ? "bg-whisper font-semibold text-calm-700 shadow-[inset_0_0_0_1px_var(--color-mist)]"
      : "font-medium text-stone-400 hover:text-stone-600"
  }`;

// The primary action pill that sits on a page header's baseline ("+ New").
export const HEADER_ACTION =
  "shrink-0 rounded-full bg-calm-600 px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-calm-700";
