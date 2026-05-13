import { useNavigate } from "react-router";

function SignUpButton() {
  const navigate = useNavigate();

  function handleClick() {
    navigate("/signup");
  }

  return (
    <button
      onClick={handleClick}
      className="w-full rounded-xl border border-calm-300 bg-white/50 px-6 py-3.5 text-base font-medium text-calm-700 transition-all duration-300 hover:border-calm-400 hover:bg-white/80 cursor-pointer"
    >
      Create Account
    </button>
  );
}

export default SignUpButton;
