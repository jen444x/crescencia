import { useState, useEffect } from "react";
import Header from "../components/layout/Header";

type Area = {
  id: number;
  name: string;
};

function AreasPage() {
  const [areas, setAreas] = useState<Area[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    async function fetchAreas() {
      setIsLoading(true);

      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/areas/`, {
          method: "GET",
          headers: {},
        });

        const data = await res.json();
        if (!res.ok) {
          setError(data.error);
          return;
        }
        console.log(data);
        setAreas(data);
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "An unknown error occurred",
        );
        console.log(error);
      } finally {
        setIsLoading(false);
      }
    }
    fetchAreas();
  }, []);

  if (isLoading) {
    return (
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-center py-12">
          <div className="w-6 h-6 border-2 border-calm-300 border-t-calm-600 rounded-full animate-spin"></div>
          <span className="ml-3 text-stone-400 text-sm">Loading areas...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-red-50 rounded-xl p-4 text-center">
          <p className="text-red-500 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (areas.length === 0) {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent-100 flex items-center justify-center">
            <span className="text-3xl">&#x1F331;</span>
          </div>
          <h3 className="font-heading text-xl text-stone-900 mb-2">
            No areas yet
          </h3>
          <p className="text-stone-400 text-sm">
            Create your first area to push your limits
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Header title="Areas" body="" />
      <div className="max-w-md mx-auto">
        <ul className="space-y-3">
          {areas.map((area) => (
            //   <ChallengeListItem key={challenge.id} challenge={challenge} />
            <li
              key={area.id}
              className="bg-white rounded-xl p-4 shadow-sm hover:shadow transition-shadow cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <h3 className="flex-1 font-medium text-stone-900">
                  {area.name}
                </h3>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

export default AreasPage;
