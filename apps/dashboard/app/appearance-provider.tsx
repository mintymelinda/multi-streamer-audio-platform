"use client";

import { useEffect, type ReactNode } from "react";

type Theme = "dark" | "light";
type AccentColor = "violet" | "blue" | "teal" | "green" | "orange" | "rose";
type AppearancePreferences = { theme: Theme; accentColor: AccentColor };

const ACCENTS: Record<AccentColor, string> = {
  violet: "#8b6cf6",
  blue: "#4f8df7",
  teal: "#24a99a",
  green: "#35a875",
  orange: "#d98a3d",
  rose: "#d96891",
};

function applyAppearance(preferences: AppearancePreferences) {
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.style.setProperty("--accent", ACCENTS[preferences.accentColor]);
}

export default function AppearanceProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let active = true;
    fetch("/api/me/preferences", { credentials: "include", cache: "no-store" })
      .then((response) => {
        if (!response.ok) return null;
        return response.json() as Promise<AppearancePreferences>;
      })
      .then((preferences) => {
        if (active && preferences) applyAppearance(preferences);
      })
      .catch(() => undefined);

    const handleUpdate = (event: Event) => {
      const customEvent = event as CustomEvent<AppearancePreferences>;
      if (customEvent.detail) applyAppearance(customEvent.detail);
    };
    window.addEventListener("appearance-preferences-updated", handleUpdate);
    return () => {
      active = false;
      window.removeEventListener("appearance-preferences-updated", handleUpdate);
    };
  }, []);

  return <>{children}</>;
}
