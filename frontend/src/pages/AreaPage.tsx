import { useState, useEffect } from "react";
import Header from "../components/layout/Header";
import { useParams } from "react-router-dom";

type Area = string;

type Habit = {
  id: number;
  name: string;
  notes: string;
};

function AreaPage() {
  const { id } = useParams();
  const [area, setArea] = useState<Area>("");
  const [habits, setHabits] = useState<Habit[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    async function fetchAreaHabits() {
      setIsLoading(true);

      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/areas/${id}`, {
          method: "GET",
        });

        const data = await res.json();
        if (!res.ok) {
          setError(data.error);
          return;
        }
        console.log(data);
        setArea(data.area);
        setHabits(data.habits);
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "An unknown error occurred",
        );
        console.log(error);
      } finally {
        setIsLoading(false);
      }
    }
    fetchAreaHabits();
  }, [id]);

  return (
    <>
      <Header title={area} body="" />
      <div className="max-w-md mx-auto">
        {isLoading && (
          <p className="text-center text-calm-500 text-sm">Loading habits...</p>
        )}
        {error && <p className="text-red-500 text-sm text-center">{error}</p>}

        {habits.length === 0 && !isLoading && (
          <p className="text-center text-calm-400 text-sm py-4">
            No habits in this area
          </p>
        )}

        <ul className="space-y-3">
          {habits.map((habit) => (
            <li
              key={habit.id}
              className="bg-white border border-calm-200 rounded-xl p-4"
            >
              <p className="text-calm-900 font-medium">{habit.name}</p>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

export default AreaPage;
