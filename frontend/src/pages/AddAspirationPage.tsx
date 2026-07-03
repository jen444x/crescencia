import { useNavigate } from "react-router-dom";
import Header from "../components/layout/Header";
import AspirationForm, {
  type AspirationValues,
} from "../components/AspirationForm";

function AddAspirationPage() {
  const navigate = useNavigate();

  async function createAspiration(values: AspirationValues) {
    const res = await fetch(
      `${import.meta.env.VITE_API_URL}/aspirations/create/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not create aspiration.");
    navigate(`/aspirations/${data.id}`);
  }

  return (
    <>
      <Header title="New aspiration" eyebrow="Where you're headed" />
      <div className="max-w-md mx-auto">
        <AspirationForm
          submitLabel="Create aspiration"
          onSubmit={createAspiration}
        />
      </div>
    </>
  );
}

export default AddAspirationPage;
