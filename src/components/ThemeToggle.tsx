import { useEffect } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { getBrandColors } from "@/lib/branding";

const ThemeToggle = ({ className }: { className?: string }) => {
  const { resolvedTheme, theme, setTheme } = useTheme();
  const activeTheme = resolvedTheme || theme;

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const colors = getBrandColors();
      meta.setAttribute("content", activeTheme === "dark" ? colors.dark : colors.primary);
    }
  }, [activeTheme]);

  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      onClick={() => setTheme(activeTheme === "dark" ? "light" : "dark")}
      aria-label="Toggle dark mode"
    >
      <Sun className="w-4 h-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute w-4 h-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
    </Button>
  );
};

export default ThemeToggle;
