"use client";

import { useEffect, useState } from "react";

type Theme = "dark" | "light";
type AccentColor = "violet" | "blue" | "teal" | "green" | "orange" | "rose";
type AppearancePreferences = { theme: Theme; accentColor: AccentColor };

const API = "/api";
const ACCENTS: { value: AccentColor; label: string; color: string }[] = [
  { value: "violet", label: "Violet", color: "#8b6cf6" },
  { value: "blue", label: "Blue", color: "#4f8df7" },
  { value: "teal", label: "Teal", color: "#24a99a" },
  { value: "green", label: "Green", color: "#35a875" },
  { value: "orange", label: "Orange", color: "#d98a3d" },
  { value: "rose", label: "Rose", color: "#d96891" },
];

function csrfToken() {
  return document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? "";
}

export default function SettingsPage() {
  const [preferences, setPreferences] = useState<AppearancePreferences>({ theme: "dark", accentColor: "violet" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API}/me/preferences`, { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 401 ? "Sign in to manage your settings." : "Could not load appearance preferences.");
        const saved = await response.json() as AppearancePreferences;
        setPreferences(saved);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load appearance preferences."))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`${API}/me/preferences`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken() },
        body: JSON.stringify({ theme: preferences.theme, accentColor: preferences.accentColor }),
      });
      if (!response.ok) throw new Error(response.status === 401 ? "Sign in to save your settings." : `Could not save preferences (${response.status}).`);
      const saved = await response.json() as AppearancePreferences;
      setPreferences(saved);
      window.dispatchEvent(new CustomEvent("appearance-preferences-updated", { detail: saved }));
      setMessage("Appearance preferences saved to your account.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save appearance preferences.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="shell">
    <header className="topbar">
      <a className="brand" href="/">♫ Streamer Audio</a>
      <nav className="page-nav"><a href="/">Dashboard</a><a href="/team">Team</a><a href="/notifications">Notifications</a><a href="/account/data-exports">Account data</a></nav>
    </header>
    <section className="welcome">
      <div><p className="eyebrow">YOUR ACCOUNT</p><h1>Appearance</h1><p className="subheading">Choose how the dashboard looks across all of your workspaces and devices.</p></div>
    </section>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {loading ? <div className="panel">Loading appearance preferences…</div> : <>
      <section className="panel settings-panel">
        <div className="panel-heading"><div><p className="eyebrow">COLOR MODE</p><h2>Theme</h2></div></div>
        <p className="subheading">Your theme is an account preference, not a workspace setting.</p>
        <fieldset className="appearance-options" aria-label="Theme">
          <button type="button" className={preferences.theme === "dark" ? "appearance-choice is-selected" : "appearance-choice"} aria-pressed={preferences.theme === "dark"} onClick={() => setPreferences((current) => ({ ...current, theme: "dark" }))}>
            <span className="theme-preview theme-preview-dark"><i /><i /><i /></span><strong>Dark</strong><small>Low-light interface</small>
          </button>
          <button type="button" className={preferences.theme === "light" ? "appearance-choice is-selected" : "appearance-choice"} aria-pressed={preferences.theme === "light"} onClick={() => setPreferences((current) => ({ ...current, theme: "light" }))}>
            <span className="theme-preview theme-preview-light"><i /><i /><i /></span><strong>Light</strong><small>Bright interface</small>
          </button>
        </fieldset>
      </section>
      <section className="panel settings-panel">
        <div className="panel-heading"><div><p className="eyebrow">ACCENT</p><h2>Accent color</h2></div></div>
        <p className="subheading">Used for primary actions, highlights, and selected controls.</p>
        <fieldset className="accent-options" aria-label="Accent color">
          {ACCENTS.map((accent) => <button type="button" key={accent.value} className={preferences.accentColor === accent.value ? "accent-choice is-selected" : "accent-choice"} aria-pressed={preferences.accentColor === accent.value} onClick={() => setPreferences((current) => ({ ...current, accentColor: accent.value }))}>
            <span style={{ backgroundColor: accent.color }} /><strong>{accent.label}</strong>
          </button>)}
        </fieldset>
      </section>
      <div className="settings-actions"><button type="button" className="primary-button" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save appearance"}</button>{message && <p role="status">{message}</p>}</div>
    </>}
    <footer className="footer"><span>Account appearance preferences</span><a href="/">Back to dashboard</a></footer>
  </main>;
}
