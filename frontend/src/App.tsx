import { Route, Routes } from "react-router";
import { ToastProvider } from "./components/Toast.tsx";
import Layout from "./components/layout/Layout.tsx";
import LandingPage from "./pages/LandingPage";
import SignUpPage from "./pages/SignUpPage.tsx";
// import LogInPage from "./pages/LogInPage.tsx";
import PlanPage from "./pages/PlanPage.tsx";
import JournalPage from "./pages/JournalPage.tsx";
import AreasPage from "./pages/AreasPage.tsx";
import AreaPage from "./pages/AreaPage.tsx";
import AspirationsPage from "./pages/AspirationsPage.tsx";
import AspirationPage from "./pages/AspirationPage.tsx";
import AddAspirationPage from "./pages/AddAspirationPage.tsx";
import EditAspirationPage from "./pages/EditAspirationPage.tsx";
import AddHabitPage from "./pages/AddHabitPage.tsx";
import EditHabitPage from "./pages/EditHabitPage.tsx";
import HabitsPage from "./pages/HabitsPage.tsx";
import EverydayRoutinePage from "./pages/EverydayRoutinePage.tsx";
import RoutinesPage from "./pages/RoutinesPage.tsx";
import RoutinePage from "./pages/RoutinePage.tsx";

function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/signup" element={<SignUpPage />} />
        <Route element={<Layout />}>
          <Route path="/plan/" element={<PlanPage />} />
          <Route path="/habits" element={<HabitsPage />} />
          <Route path="/journal/" element={<JournalPage />} />
          <Route path="/habits/new" element={<AddHabitPage />} />
          <Route path="/habits/:id" element={<EditHabitPage />} />
          <Route path="/areas" element={<AreasPage />} />
          <Route path="/areas/:id" element={<AreaPage />} />
          <Route path="/aspirations" element={<AspirationsPage />} />
          <Route path="/aspirations/new" element={<AddAspirationPage />} />
          <Route path="/aspirations/:id" element={<AspirationPage />} />
          <Route path="/aspirations/:id/edit" element={<EditAspirationPage />} />
          <Route path="/routine" element={<EverydayRoutinePage />} />
          <Route path="/routines" element={<RoutinesPage />} />
          <Route path="/routines/:id" element={<RoutinePage />} />
        </Route>
      </Routes>
    </ToastProvider>
  );
}

export default App;
