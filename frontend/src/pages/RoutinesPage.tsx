import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/layout/Header";

// A routine group from GET /routines/ — just id + name. Membership lives on the
// schedule rows and is managed on the detail page.
type Routine = { id: number; name: string };

function RoutinesPage() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  // Inline "new routine" form: toggled open by the + button, then a name + Create.
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  async function load() {
    setIsLoading(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/routines/`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not load your routines.");
        return;
      }
      setRoutines(data);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Create a routine, then jump straight into its detail page so habits can be
  // added right away.
  async function createRoutine() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/routines/create/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create that routine.");
        return;
      }
      navigate(`/routines/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unknown error occurred");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <Header title="Routines" body="" />
      <div className="max-w-md mx-auto">
        {!adding ? (
          <button
            onClick={() => setAdding(true)}
            className="w-full mb-4 bg-calm-600 text-white py-3 rounded-xl font-medium hover:bg-calm-700 transition-colors"
          >
            + New routine
          </button>
        ) : (
          <div className="mb-4 rounded-xl bg-white p-3 shadow-sm">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createRoutine();
                if (e.key === "Escape") {
                  setAdding(false);
                  setNewName("");
                }
              }}
              placeholder="Routine name (e.g. Morning routine)"
              className="w-full rounded-lg border border-calm-200 px-3 py-2 text-sm text-calm-900 focus:border-calm-400 focus:outline-none"
            />
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => {
                  setAdding(false);
                  setNewName("");
                }}
                className="flex-1 rounded-lg border border-calm-200 py-2 text-sm font-medium text-calm-700 transition-colors hover:bg-calm-50"
              >
                Cancel
              </button>
              <button
                onClick={createRoutine}
                disabled={creating || !newName.trim()}
                className="flex-1 rounded-lg bg-calm-600 py-2 text-sm font-medium text-white transition-colors hover:bg-calm-700 disabled:opacity-40"
              >
                Create
              </button>
            </div>
          </div>
        )}

        {isLoading && (
          <p className="text-center text-calm-500 text-sm">Loading routines...</p>
        )}
        {error && <p className="text-red-500 text-sm text-center">{error}</p>}

        {!isLoading && !error && routines.length === 0 && (
          <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
            <h3 className="font-heading text-xl text-stone-900 mb-2">
              No routines yet
            </h3>
            <p className="text-stone-400 text-sm">
              Make one to group habits you do together, like a morning routine.
            </p>
          </div>
        )}

        <ul className="space-y-3">
          {routines.map((r) => (
            <li key={r.id} className="bg-white rounded-xl shadow-sm overflow-hidden">
              <button
                onClick={() => navigate(`/routines/${r.id}`)}
                className="flex w-full items-center gap-2 p-4 text-left"
              >
                <h3 className="flex-1 font-medium text-stone-900">{r.name}</h3>
                <span className="text-calm-300" aria-hidden>
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

export default RoutinesPage;
