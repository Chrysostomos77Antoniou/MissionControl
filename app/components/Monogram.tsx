export function initials(name: string): string {
  const words = name.split(/[^A-Za-z]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function Monogram({ name, accent, size = 46 }: { name: string; accent: string; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: `1px solid ${accent}44`,
        background: `radial-gradient(circle at 32% 28%, ${accent}26, rgba(255,255,255,0.015))`,
        color: accent,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        fontSize: size * 0.34,
        letterSpacing: "0.01em",
      }}
    >
      {initials(name)}
    </div>
  );
}
