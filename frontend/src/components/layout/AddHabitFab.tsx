import { Link } from "react-router-dom";

// Floating "+" button that opens the Add habit page. Sits above the bottom nav.
function AddHabitFab() {
  return (
    <Link
      to="/habits/new"
      aria-label="Add habit"
      className="fixed bottom-28 right-6 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-calm-600 text-white shadow-lg hover:bg-calm-700 transition-colors"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-7 w-7"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 4v16m8-8H4"
        />
      </svg>
    </Link>
  );
}

export default AddHabitFab;
