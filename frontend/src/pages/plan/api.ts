// The Plan page's IO layer: every call that talks to the server for a day's
// board lives here, so the component and hooks stay about state + rendering, not
// URL-building. Pure network — no React, no setState. Add the other Plan writes
// (/days/arrange/, /days/clear/, /days/skip/) here as they get pulled out.
import { isSameDay, toYMD } from "./dates";
import type { Chain, DayNote } from "./types";

const API = import.meta.env.VITE_API_URL;

// "" for today (matches the original behaviour), "?date=YYYY-MM-DD" when browsing
// any other day.
function dateSuffix(date: Date): string {
  return isSameDay(date, new Date()) ? "" : `?date=${toYMD(date)}`;
}

// GET the Plan board — the day's time blocks and their habits — as Chain[].
// Throws with the server's error message on a non-2xx so the caller can surface
// it (loadDay routes it to setError).
export async function fetchChains(date: Date): Promise<Chain[]> {
  const res = await fetch(`${API}/plan/${dateSuffix(date)}`, { method: "GET" });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? "");
  return data as Chain[];
}

// GET the day's notes. Notes are additive: if the endpoint isn't live yet or
// errors, we fall back to none rather than failing the whole page load — so a
// notes hiccup never blanks the board.
export async function fetchDayNotes(date: Date): Promise<DayNote[]> {
  try {
    const res = await fetch(`${API}/days/notes/${dateSuffix(date)}`, {
      method: "GET",
    });
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}
