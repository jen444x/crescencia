import { NavLink } from "react-router-dom";

function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-gradient-to-r from-calm-600 to-calm-500 px-6 pt-3 pb-6 shadow-lg">
      <div className="flex justify-around items-center">
        <NavLink
          to="/dashboard"
          className={({ isActive }) =>
            `flex flex-col items-center px-6 py-2 rounded-xl transition-all ${
              isActive
                ? "bg-white/20 text-white"
                : "text-white/60 hover:text-white/80"
            }`
          }
        >
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
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
            />
          </svg>
          <span className="text-xs mt-1 font-medium">Habits</span>
        </NavLink>

        <NavLink
          to="/challenges"
          className={({ isActive }) =>
            `flex flex-col items-center px-6 py-2 rounded-xl transition-all ${
              isActive
                ? "bg-white/20 text-white"
                : "text-white/60 hover:text-white/80"
            }`
          }
        >
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
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
          <span className="text-xs mt-1 font-medium">Challenges</span>
        </NavLink>

        <NavLink
          to="/insights"
          className={({ isActive }) =>
            `flex flex-col items-center px-6 py-2 rounded-xl transition-all ${
              isActive
                ? "bg-white/20 text-white"
                : "text-white/60 hover:text-white/80"
            }`
          }
        >
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
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
            />
          </svg>
          <span className="text-xs mt-1 font-medium">Insights</span>
        </NavLink>
      </div>
    </nav>
  );
}

export default BottomNav;
