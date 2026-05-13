import LogInButton from "../components/auth/LogInButton";
import SignUpButton from "../components/auth/SignUpButton";

function LandingPage() {
  return (
    <div className="flex flex-col min-h-screen items-center bg-linear-to-b from-warm-100 to-calm-50">
      <h1 className="pt-32 font-heading text-6xl font-light tracking-widest text-calm-900">
        Crescencia
      </h1>
      <p className="mt-3 text-sm font-light tracking-widest text-calm-500 uppercase">
        what if it all works out
      </p>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 w-72">
        <LogInButton />
        <SignUpButton />
      </div>
    </div>
  );
}

export default LandingPage;
