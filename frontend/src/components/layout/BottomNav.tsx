import { NavLink } from "react-router-dom";

// Shared style for the nav tabs: the active one sits in a soft whisper-green
// well; the rest stay quiet until hovered.
const tabClass = ({ isActive }: { isActive: boolean }) =>
  `flex flex-1 flex-col items-center gap-0.5 rounded-full py-1.5 transition-colors ${
    isActive
      ? "bg-whisper text-calm-700 shadow-[inset_0_0_0_1px_var(--color-mist)]"
      : "text-calm-400 hover:text-calm-600"
  }`;

// The four destinations: daily Plan, Aspirations, Habits, and Journal. Adding a
// habit lives on the Habits page now (it didn't belong in the nav). Areas/Insights
// can still slot back in here once those pages are ready.
function BottomNav() {
  return (
    // A frosted pill floating above the page instead of a full-bleed bar.
    // z-40 keeps it above page content (chain step badges are z-10, so
    // without this they show through when rows scroll behind the pill).
    <nav className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-4 right-4 z-40">
      <div className="mx-auto flex max-w-md items-center gap-0.5 rounded-full border border-mist bg-white/80 p-1.5 shadow-[0_6px_22px_rgba(27,46,42,0.12)] backdrop-blur-md">
        <NavLink to="/plan/" className={tabClass}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.8}
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          <span className="text-[10px] font-semibold">Plan</span>
        </NavLink>

        <NavLink to="/aspirations" className={tabClass}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.8}
              d="M3 3v1.5M3 21v-6m0 0l2.77-.693a9 9 0 016.208.682l.108.054a9 9 0 006.086.71l3.114-.732a48.524 48.524 0 01-.005-10.499l-3.11.732a9 9 0 01-6.085-.711l-.108-.054a9 9 0 00-6.208-.682L3 4.5M3 15V4.5"
            />
          </svg>
          <span className="text-[10px] font-semibold">Aspirations</span>
        </NavLink>

        <NavLink to="/habits" end className={tabClass}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.8}
              d="M5 13l4 4L19 7"
            />
          </svg>
          <span className="text-[10px] font-semibold">Habits</span>
        </NavLink>

        <NavLink to="/journal/" className={tabClass}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.8}
              d="M12 6.5C10.5 5 8 4.5 4 5v13c4-.5 6.5 0 8 1.5M12 6.5C13.5 5 16 4.5 20 5v13c-4-.5-6.5 0-8 1.5M12 6.5v13"
            />
          </svg>
          <span className="text-[10px] font-semibold">Journal</span>
        </NavLink>
      </div>
    </nav>
  );
}

export default BottomNav;
