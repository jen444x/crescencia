import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Header from "../components/layout/Header";
import { CARD, F_LABEL, HEADER_CHIP } from "../components/ui";

type VersionProgress = {
  level: number;
  name: string; // "Roots" / "Growth" / ...
  value: string; // e.g. "5000 steps"
  days: boolean[]; // oldest first; last = today
  streak: number;
};

type HabitProgress = {
  id: number;
  name: string;
  tiers: VersionProgress[]; // one row per version; [] when the habit is untiered
  days: boolean[]; // untiered habit only (oldest first; last = today)
  streak: number;
};

// A habit/version's last-N-days completion as filled/hollow dots. The row is a
// grid that shares the card's width equally, so it can never spill off the
// card on a narrow phone (fixed-size dots could).
function DotRow({ days }: { days: boolean[] }) {
  return (
    <div
      className="grid gap-[5px]"
      style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
    >
      {days.map((done, i) => (
        <span
          key={i}
          className={`aspect-square w-full max-w-[15px] rounded-full ${
            done ? "bg-calm-600" : "border-[1.5px] border-mist"
          }`}
        />
      ))}
    </div>
  );
}

type AspirationDetail = {
  id: number;
  name: string;
  reason: string;
  motivation: string;
  notes: string;
  created_at: string;
  habit_ids: number[];
  habits: HabitProgress[];
  progress_days: number;
};

function AspirationPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<AspirationDetail | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    async function fetchAspiration() {
      setIsLoading(true);
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/aspirations/${id}/`,
        );
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Could not load aspiration.");
          return;
        }
        setDetail(data);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unknown error occurred",
        );
      } finally {
        setIsLoading(false);
      }
    }
    fetchAspiration();
  }, [id]);

  if (isLoading) {
    return (
      <div className="max-w-md mx-auto">
        <p className="text-center text-calm-500 text-sm py-8">Loading...</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="max-w-md mx-auto">
        <p className="text-red-500 text-sm text-center py-8">{error}</p>
      </div>
    );
  }
  if (!detail) return null;

  return (
    <>
      <Header
        title={detail.name}
        eyebrow="Aspiration"
        action={
          <button
            onClick={() => navigate(`/aspirations/${id}/edit`)}
            className={HEADER_CHIP}
          >
            Edit
          </button>
        }
      />
      <div className="max-w-md mx-auto space-y-4">

        {detail.reason && (
          <div className={`p-4 ${CARD}`}>
            <p className={F_LABEL}>
              Reason
            </p>
            <p className="text-ink text-sm whitespace-pre-wrap">
              {detail.reason}
            </p>
          </div>
        )}
        {detail.motivation && (
          <div className={`p-4 ${CARD}`}>
            <p className={F_LABEL}>
              Motivation
            </p>
            <p className="text-ink text-sm whitespace-pre-wrap">
              {detail.motivation}
            </p>
          </div>
        )}
        {detail.notes && (
          <div className={`p-4 ${CARD}`}>
            <p className={F_LABEL}>
              Notes
            </p>
            <p className="text-ink text-sm whitespace-pre-wrap">
              {detail.notes}
            </p>
          </div>
        )}

        <div>
          <div className="flex items-baseline justify-between mb-2 px-1">
            <h2 className="font-heading text-xl text-ink">
              How it's going
            </h2>
            <span className="text-xs text-stone-400">
              last {detail.progress_days} days
            </span>
          </div>

          {detail.habits.length === 0 ? (
            <div className={`p-6 text-center ${CARD}`}>
              <p className="text-stone-400 text-sm">
                No habits attached yet. Edit this aspiration to add some.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {detail.habits.map((h) => (
                <li key={h.id} className={`p-4 ${CARD}`}>
                  {h.tiers.length > 0 ? (
                    <>
                      <p className="text-ink font-medium text-sm mb-3">
                        {h.name}
                      </p>
                      <div className="space-y-3">
                        {h.tiers.map((t) => (
                          <div key={t.level}>
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-xs font-medium text-calm-600">
                                {t.name}
                                {t.value && (
                                  <span className="text-calm-400">
                                    {" · "}
                                    {t.value}
                                  </span>
                                )}
                              </span>
                              <span className="whitespace-nowrap rounded-full bg-petal px-2 py-0.5 text-[11px] font-semibold text-calm-700">
                                🔥 {t.streak}
                              </span>
                            </div>
                            <DotRow days={t.days} />
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-ink font-medium text-sm">
                          {h.name}
                        </p>
                        <span className="whitespace-nowrap rounded-full bg-petal px-2 py-0.5 text-[11px] font-semibold text-calm-700">
                          🔥 {h.streak}
                        </span>
                      </div>
                      <DotRow days={h.days} />
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

export default AspirationPage;
