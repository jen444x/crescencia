import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/layout/Header";

type Aspiration = { id: number; name: string };

function AspirationsPage() {
  const [aspirations, setAspirations] = useState<Aspiration[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    async function fetchAspirations() {
      setIsLoading(true);
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/aspirations/`);
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Could not load aspirations.");
          return;
        }
        setAspirations(data);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unknown error occurred",
        );
      } finally {
        setIsLoading(false);
      }
    }
    fetchAspirations();
  }, []);

  return (
    <>
      <Header title="Aspirations" body="" />
      <div className="max-w-md mx-auto">
        <button
          onClick={() => navigate("/aspirations/new")}
          className="w-full mb-4 bg-calm-600 text-white py-3 rounded-xl font-medium hover:bg-calm-700 transition-colors"
        >
          + New aspiration
        </button>

        {isLoading && (
          <p className="text-center text-calm-500 text-sm">
            Loading aspirations...
          </p>
        )}
        {error && <p className="text-red-500 text-sm text-center">{error}</p>}

        {!isLoading && !error && aspirations.length === 0 && (
          <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
            <h3 className="font-heading text-xl text-stone-900 mb-2">
              No aspirations yet
            </h3>
            <p className="text-stone-400 text-sm">
              Add one to group the habits that move you toward it.
            </p>
          </div>
        )}

        <ul className="space-y-3">
          {aspirations.map((a) => (
            <li
              key={a.id}
              onClick={() => navigate(`/aspirations/${a.id}`)}
              className="bg-white rounded-xl p-4 shadow-sm hover:shadow transition-shadow cursor-pointer"
            >
              <h3 className="font-medium text-stone-900">{a.name}</h3>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

export default AspirationsPage;
