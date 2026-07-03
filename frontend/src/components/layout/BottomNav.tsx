import { NavLink } from "react-router-dom";

// Shared style for the nav tabs. The active tab sits in a soft sage pill; the
// rest stay quiet warm gray — a calm bar, not a banner.
const tabClass = ({ isActive }: { isActive: boolean }) =>
  `flex flex-1 flex-col items-center gap-1 py-2 rounded-xl transition-all ${
    isActive
      ? "bg-sage-100 text-sage-800"
      : "text-stone-400 hover:text-stone-600"
  }`;

// The four destinations: daily Plan, Aspirations, Habits, and Journal. Adding a
// habit lives on the Habits page now (it didn't belong in the nav). Areas/Insights
// can still slot back in here once those pages are ready.
function BottomNav() {
  return (
    // z-40 keeps the bar above page content (chain step badges are z-10, so
    // without this they show through when rows scroll behind the bar).
    <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-stone-200/70 bg-white/95 px-6 pt-2 pb-6 backdrop-blur">
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

        <NavLink to="/aspirations" className={tabClass}>
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
              d="M3 3v1.5M3 21v-6m0 0l2.77-.693a9 9 0 016.208.682l.108.054a9 9 0 006.086.71l3.114-.732a48.524 48.524 0 01-.005-10.499l-3.11.732a9 9 0 01-6.085-.711l-.108-.054a9 9 0 00-6.208-.682L3 4.5M3 15V4.5"
            />
          </svg>
          <span className="text-xs font-medium">Aspirations</span>
        </NavLink>

        <NavLink to="/habits" end className={tabClass}>
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
              d="M5 13l4 4L19 7"
            />
          </svg>
          <span className="text-xs font-medium">Habits</span>
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
      </div>
    </nav>
  );
}

export default BottomNav;
