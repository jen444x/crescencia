import { NavLink } from "react-router-dom";

// Shared style for the nav tabs (highlighted when active).
const tabClass = ({ isActive }: { isActive: boolean }) =>
  `flex flex-1 flex-col items-center gap-1 py-2 rounded-xl transition-all ${
    isActive ? "bg-white/20 text-white" : "text-white/60 hover:text-white/80"
  }`;

// Just the two destinations we have today: the daily Plan and Add habit. More
// tabs (Areas, Insights) can slot back in here once those pages are ready.
function BottomNav() {
  return (
    // z-40 keeps the bar above page content (chain step badges are z-10, so
    // without this they show through when rows scroll behind the bar).
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-gradient-to-r from-calm-600 to-calm-500 px-6 pt-3 pb-6 shadow-lg">
      <div className="mx-auto flex max-w-md items-center gap-2">
        <NavLink to="/plan/" className={tabClass}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          <span className="text-xs font-medium">Plan</span>
        </NavLink>

        <NavLink to="/journal/" className={tabClass}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 6.5C10.5 5 8 4.5 4 5v13c4-.5 6.5 0 8 1.5M12 6.5C13.5 5 16 4.5 20 5v13c-4-.5-6.5 0-8 1.5M12 6.5v13"
            />
          </svg>
          <span className="text-xs font-medium">Journal</span>
        </NavLink>

        <NavLink to="/habits/new" className={tabClass}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
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
          <span className="text-xs font-medium">Add Habit</span>
        </NavLink>
      </div>
    </nav>
  );
}

export default BottomNav;
