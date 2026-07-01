// A slowly-rotating robotic/HUD globe that sits behind the whole dashboard.
// Pure CSS (see .earth in globals.css) — no deps, keeps the amber theme.
export function RoboticEarth() {
  return (
    <div aria-hidden className="earth-bg">
      <div className="earth" />
    </div>
  );
}
