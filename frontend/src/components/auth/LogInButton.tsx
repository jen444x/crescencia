import { useNavigate } from "react-router";

function LogInButton() {
  const navigate = useNavigate();

  function handleClick() {
    navigate("/login");
  }

  return (
    <button
      onClick={handleClick}
      className="w-full rounded-xl bg-calm-600 px-6 py-3.5 text-base font-medium text-white shadow-sm hover:bg-calm-500 hover:shadow-md cursor-pointer"
    >
      Log In
    </button>
  );
}

export default LogInButton;
