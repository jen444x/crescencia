import { Outlet } from "react-router";
import BottomNav from "./BottomNav";

function Layout() {
  return (
    <>
      {/* Full-bleed background: a soft near-white → pale-sage wash (bg-fixed so
          it stays put while the page scrolls) — the airy "white light" feel from
          the mock, instead of a flat fill. Content is held to a centered phone-
          width column (max-w-md, matching the nav) so nothing sprawls on wider
          screens. pb-32 leaves room for the fixed nav. */}
      <div className="min-h-screen bg-linear-to-b from-[#f7fbf9] to-[#e4f0ea] bg-fixed pb-32">
        <div className="mx-auto max-w-md px-6 pt-[calc(2rem+env(safe-area-inset-top))]">
          <Outlet />
        </div>
      </div>
      <BottomNav />
    </>
  );
}

export default Layout;
