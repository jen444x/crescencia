import { Outlet } from "react-router";
import BottomNav from "./BottomNav";

function Layout() {
  return (
    <>
      <div className="min-h-screen bg-calm-50 px-6 pt-12 pb-32">
        {/* padding-bottom for nav height */}
        <Outlet />
      </div>
      <BottomNav />
    </>
  );
}

export default Layout;
