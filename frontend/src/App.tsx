import { Route, Routes } from "react-router";
import Layout from "./components/layout/Layout.tsx";
import LandingPage from "./pages/LandingPage";
import SignUpPage from "./pages/SignUpPage.tsx";
// import LogInPage from "./pages/LogInPage.tsx";
import PlanPage from "./pages/PlanPage.tsx";
import AreasPage from "./pages/AreasPage.tsx";
import AreaPage from "./pages/AreaPage.tsx";
import AddHabitPage from "./pages/AddHabitPage.tsx";
import EditHabitPage from "./pages/EditHabitPage.tsx";

function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/signup" element={<SignUpPage />} />
        <Route element={<Layout />}>
          <Route path="/plan/" element={<PlanPage />} />
          <Route path="/habits/new" element={<AddHabitPage />} />
          <Route path="/habits/:id" element={<EditHabitPage />} />
          <Route path="/areas" element={<AreasPage />} />
          <Route path="/areas/:id" element={<AreaPage />} />
        </Route>
      </Routes>
    </>
  );
}

export default App;
