import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Header from "../components/layout/Header";

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

// A habit/version's last-N-days completion as filled/hollow dots.
function DotRow({ days }: { days: boolean[] }) {
  return (
    <div className="flex items-center gap-1.5">
      {days.map((done, i) => (
        <span
          key={i}
          className={`h-3 w-3 rounded-full ${
            done ? "bg-calm-600" : "border border-calm-300"
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
      <Header title={detail.name} body="" />
      <div className="max-w-md mx-auto space-y-4">
        <button
          onClick={() => navigate(`/aspirations/${id}/edit`)}
          className="w-full bg-white border border-calm-200 text-calm-700 py-2.5 rounded-xl font-medium text-sm hover:border-calm-400 transition-colors"
        >
          Edit aspiration
        </button>

        {detail.reason && (
          <div className="bg-white rounded-xl p-4 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-calm-500 mb-1">
              Reason
            </p>
            <p className="text-calm-900 text-sm whitespace-pre-wrap">
              {detail.reason}
            </p>
          </div>
        )}
        {detail.motivation && (
          <div className="bg-white rounded-xl p-4 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-calm-500 mb-1">
              Motivation
            </p>
            <p className="text-calm-900 text-sm whitespace-pre-wrap">
              {detail.motivation}
            </p>
          </div>
        )}
        {detail.notes && (
          <div className="bg-white rounded-xl p-4 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-calm-500 mb-1">
              Notes
            </p>
            <p className="text-calm-900 text-sm whitespace-pre-wrap">
              {detail.notes}
            </p>
          </div>
        )}

        <div>
          <div className="flex items-baseline justify-between mb-2 px-1">
            <h2 className="font-heading text-xl text-calm-900">
              How it's going
            </h2>
            <span className="text-xs text-calm-400">
              last {detail.progress_days} days
            </span>
          </div>

          {detail.habits.length === 0 ? (
            <div className="bg-white rounded-xl p-6 text-center shadow-sm">
              <p className="text-calm-400 text-sm">
                No habits attached yet. Edit this aspiration to add some.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {detail.habits.map((h) => (
                <li key={h.id} className="bg-white rounded-xl p-4 shadow-sm">
                  {h.tiers.length > 0 ? (
                    <>
                      <p className="text-calm-900 font-medium text-sm mb-3">
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
                              <span className="text-xs text-calm-500 whitespace-nowrap">
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
                        <p className="text-calm-900 font-medium text-sm">
                          {h.name}
                        </p>
                        <span className="text-xs text-calm-500 whitespace-nowrap">
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
