import { Route, Routes } from "react-router";
import Layout from "./components/layout/Layout.tsx";
import LandingPage from "./pages/LandingPage";
import SignUpPage from "./pages/SignUpPage.tsx";
// import LogInPage from "./pages/LogInPage.tsx";
import AreasPage from "./pages/AreasPage.tsx";
import AreaPage from "./pages/AreaPage.tsx";

function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/signup" element={<SignUpPage />} />
        <Route element={<Layout />}>
          <Route path="/areas" element={<AreasPage />} />
          <Route path="area/:id" element={<AreaPage />} />
        </Route>
      </Routes>
    </>
  );
}

export default App;
