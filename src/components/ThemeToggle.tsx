import type { Theme } from "../services/ThemeService";

type ThemeToggleProps = {
  theme: Theme;
  onToggle: () => void;
};

export function ThemeToggle(props: ThemeToggleProps): JSX.Element {
  const { theme, onToggle } = props;
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="btn btn-ghost theme-toggle"
      onClick={onToggle}
      aria-label={isDark ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
      title={isDark ? "Tema claro" : "Tema oscuro"}
    >
      {isDark ? "\u2600\ufe0f" : "\u{1F319}"}
    </button>
  );
}
