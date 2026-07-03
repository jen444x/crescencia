// Day-navigation date helpers (browsing other days on the Plan page).

// Local midnight — the canonical value we compare/store a viewed day by.
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Local "YYYY-MM-DD" for the API. NOT toISOString() — that's UTC and can land on
// the wrong calendar day near midnight.
export function toYMD(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function addDays(date: Date, days: number): Date {
  const result = startOfDay(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// "Today" / "Yesterday" / "Tomorrow", else e.g. "Sat, Jun 13".
export function dayLabel(date: Date): string {
  const diff = Math.round(
    (startOfDay(date).getTime() - startOfDay(new Date()).getTime()) /
      86_400_000,
  );
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  if (diff === 1) return "Tomorrow";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// "08:00:00" -> "8:00 AM"; null/empty -> "Anytime"
export function formatTime(time: string | null) {
  if (!time) return "Anytime";
  const [hourStr, minute] = time.split(":");
  const hour = parseInt(hourStr, 10);
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${minute} ${period}`;
}

// "08:30:00" -> 510 (minutes since midnight). Used to find which time block
// is "now" so we can open the page there.
export function timeToMinutes(time: string): number {
  const [hourStr, minuteStr] = time.split(":");
  return parseInt(hourStr, 10) * 60 + parseInt(minuteStr, 10);
}

// 510 -> "08:30". The inverse of timeToMinutes — the absolute time we send to
// /plans/retime/ when a chain's time header is dragged.
export function minutesToHHMM(total: number): string {
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
