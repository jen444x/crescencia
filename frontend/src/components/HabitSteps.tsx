import { useState } from "react";
import { CARD, CARD_TITLE, BTN_PRIMARY } from "./ui";

// One rung of the habit's ladder, as the steps editor needs it.
export type StepRung = {
  version: number; // the Version id
  level: number; // ladder position, 1 = lowest
  value: string; // "3 mins"
  label: number | null; // 1=Roots, 2=Growth, null = untagged
  steps: { id: number; step: number; name: string; amount: string }[];
};

// One editable line: a step used by one rung, at some amount. `stepId` is the
// habit-level Step it refers to (absent while it's brand new). `key` is a local
// id so React and the "same step in two rungs" merge have something stable to
// hold on to before the server assigns one.
type Row = { key: string; stepId?: number; name: string; amount: string };

let nextKey = 1;
const newKey = () => `new-${nextKey++}`;

// The steps editor: what you actually DO inside a habit, per rung.
//
// Steps live on the HABIT and their amounts live per VERSION, so "cat cow" is
// one thing that shows up at 1 min on Roots and 3 mins on Growth. The editing
// surface is per-rung anyway (that's how she thinks about it), and identity is
// carried by stepId — so renaming a step on any rung renames it on all of them.
function HabitSteps({
  habitId,
  rungs,
  onSaved,
}: {
  habitId: number;
  rungs: StepRung[];
  onSaved: (tiers: unknown) => void;
}) {
  const [rows, setRows] = useState<Map<number, Row[]>>(() => {
    const initial = new Map<number, Row[]>();
    for (const rung of rungs) {
      initial.set(
        rung.version,
        rung.steps.map((s) => ({
          key: `v${rung.version}-s${s.step}`,
          stepId: s.step,
          name: s.name,
          amount: s.amount,
        })),
      );
    }
    return initial;
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  function edit(version: number, fn: (rows: Row[]) => Row[]) {
    setSaved(false);
    setRows((prev) => {
      const next = new Map(prev);
      next.set(version, fn(next.get(version) ?? []));
      return next;
    });
  }

  // Renaming a step renames it on EVERY rung that uses it — that's the whole
  // point of steps living on the habit rather than on each rung separately.
  function renameStep(version: number, key: string, name: string) {
    setSaved(false);
    setRows((prev) => {
      const row = (prev.get(version) ?? []).find((r) => r.key === key);
      const stepId = row?.stepId;
      const next = new Map<number, Row[]>();
      for (const [vid, list] of prev) {
        next.set(
          vid,
          list.map((r) =>
            r.key === key || (stepId != null && r.stepId === stepId)
              ? { ...r, name }
              : r,
          ),
        );
      }
      return next;
    });
  }

  async function save() {
    setIsSaving(true);
    setError("");
    try {
      // Collapse the per-rung lines into the habit's step list. Identity is the
      // step id when there is one, else the name — so adding "Hamstring" to two
      // rungs separately still creates ONE step, not two with the same name.
      const order: string[] = [];
      const byIdentity = new Map<string, { id?: number; name: string }>();
      const identityOf = (r: Row) =>
        r.stepId != null ? `id:${r.stepId}` : `name:${r.name.trim().toLowerCase()}`;

      for (const rung of rungs) {
        for (const r of rows.get(rung.version) ?? []) {
          if (!r.name.trim()) continue;
          const id = identityOf(r);
          if (!byIdentity.has(id)) {
            byIdentity.set(id, { id: r.stepId, name: r.name.trim() });
            order.push(id);
          }
        }
      }

      const steps = order.map((id) => {
        const s = byIdentity.get(id)!;
        return s.id != null ? { id: s.id, name: s.name } : { name: s.name };
      });
      const indexOf = new Map(order.map((id, i) => [id, i]));

      const amounts = [];
      for (const rung of rungs) {
        for (const r of rows.get(rung.version) ?? []) {
          if (!r.name.trim()) continue;
          const id = identityOf(r);
          amounts.push({
            version: rung.version,
            step: r.stepId != null ? r.stepId : { new: indexOf.get(id) },
            amount: r.amount.trim(),
          });
        }
      }

      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/habits/${habitId}/steps/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ steps, amounts }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save steps.");
      onSaved(data.tiers);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setIsSaving(false);
    }
  }

  if (rungs.length === 0) {
    return (
      <section className={`mt-4 p-4 ${CARD}`}>
        <h2 className={CARD_TITLE}>Steps</h2>
        <p className="mt-1 text-xs text-stone-400">
          Add a rung to the ladder first — steps hang off a rung, so each one can
          ask for a different amount.
        </p>
      </section>
    );
  }

  // Every step name already used on this habit, for the datalist suggestions —
  // picking an existing name is what reuses the step instead of making a new one.
  const known = Array.from(
    new Set(
      [...rows.values()].flat().map((r) => r.name.trim()).filter(Boolean),
    ),
  );

  return (
    <section className={`mt-4 p-4 ${CARD}`}>
      <h2 className={CARD_TITLE}>Steps</h2>
      <p className="mt-1 text-xs text-stone-400">
        What you actually do at each rung. The same step can appear on several
        rungs at different amounts — renaming it anywhere renames it everywhere.
        Leave this empty for habits that aren't a recipe.
      </p>

      <datalist id={`steps-${habitId}`}>
        {known.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      <div className="mt-3 space-y-4">
        {rungs.map((rung) => (
          <div key={rung.version}>
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-calm-50 text-[11px] font-bold text-stone-400">
                {rung.level}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-ink">
                {rung.value || <span className="text-stone-400">no amount</span>}
              </span>
              {rung.label && (
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    rung.label === 1
                      ? "bg-blush text-clay"
                      : "bg-mint text-calm-700"
                  }`}
                >
                  {rung.label === 1 ? "Roots" : "Growth"}
                </span>
              )}
            </div>

            <div className="mt-1.5 ml-2.5 space-y-1.5 border-l-2 border-calm-300 pl-3">
              {(rows.get(rung.version) ?? []).map((r) => (
                <div key={r.key} className="flex items-center gap-1.5">
                  <input
                    value={r.name}
                    list={`steps-${habitId}`}
                    onChange={(e) =>
                      renameStep(rung.version, r.key, e.target.value)
                    }
                    placeholder="Cat cow"
                    maxLength={120}
                    className="min-w-0 flex-1 rounded-lg border border-mist bg-whisper px-2.5 py-1.5 text-[13px] text-ink placeholder:text-stone-400 focus:border-calm-400 focus:outline-none"
                  />
                  <input
                    value={r.amount}
                    onChange={(e) =>
                      edit(rung.version, (list) =>
                        list.map((x) =>
                          x.key === r.key ? { ...x, amount: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder="3 mins"
                    maxLength={100}
                    className="w-20 shrink-0 rounded-lg border border-mist bg-whisper px-2 py-1.5 text-[13px] text-ink placeholder:text-stone-400 focus:border-calm-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${r.name || "step"}`}
                    onClick={() =>
                      edit(rung.version, (list) =>
                        list.filter((x) => x.key !== r.key),
                      )
                    }
                    className="shrink-0 px-1 text-stone-300 transition-colors hover:text-clay"
                  >
                    ✕
                  </button>
                </div>
              ))}

              <button
                type="button"
                onClick={() =>
                  edit(rung.version, (list) => [
                    ...list,
                    { key: newKey(), name: "", amount: "" },
                  ])
                }
                className="text-[11.5px] font-semibold text-calm-600 transition-colors hover:text-calm-700"
              >
                + Add step
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && <p className="mt-3 text-center text-sm text-red-500">{error}</p>}

      <button
        type="button"
        onClick={save}
        disabled={isSaving}
        className={`mt-4 ${BTN_PRIMARY}`}
      >
        {isSaving ? "Saving..." : saved ? "Saved ✓" : "Save steps"}
      </button>
    </section>
  );
}

export default HabitSteps;
