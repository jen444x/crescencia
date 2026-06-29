// A "+ Add habit" button at the bottom of a cycle/time block. It just opens the
// full Add Habit page (carrying the target cycle in the URL); that page creates
// the habit and drops it into the cycle. Shared by the Plan page (day routine)
// and the Everyday routine page so the control reads the same in both.
function AddHabitButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full px-4 py-2.5 text-left text-sm font-medium text-calm-500 transition-colors hover:text-calm-700"
    >
      ＋ Add habit
    </button>
  );
}

export default AddHabitButton;
