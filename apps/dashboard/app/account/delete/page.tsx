"use client";

import { useState } from "react";

const API = "/api";
const CONFIRMATION = "DELETE MY ACCOUNT";

function csrf() {
  return document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? "";
}

export default function DeleteAccountPage() {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function deleteAccount() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}/me`, {
        method: "DELETE",
        headers: { "x-csrf-token": csrf() },
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { message?: string | string[] } | null;
        const message = Array.isArray(payload?.message) ? payload.message.join(" ") : payload?.message;
        throw new Error(message || `Account deletion failed (${response.status}).`);
      }
      window.location.assign("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account deletion could not be completed.");
      setBusy(false);
    }
  }

  return <main className="shell">
    <header className="topbar"><a className="brand" href="/">♫ Streamer Audio</a><nav className="page-nav"><a href="/">Dashboard</a><a href="/account/data-exports">Account data</a></nav></header>
    <section className="welcome"><div><p className="eyebrow">ACCOUNT CONTROL</p><h1>Delete your account</h1><p className="subheading">This permanently deletes your platform account. This action cannot be undone.</p></div></section>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <section className="panel team-panel">
      <div className="panel-heading"><div><p className="eyebrow">BEFORE YOU CONTINUE</p><h2>What will be deleted</h2></div></div>
      <ul>
        <li>Your platform account and all active sessions.</li>
        <li>Your workspace memberships and invitations addressed to your Twitch account.</li>
        <li>Your notifications, notification preferences, email settings, appearance preferences, and personal export history.</li>
        <li>Your account-linked OAuth transactions and personal authentication records.</li>
      </ul>
      <p className="subheading">You must delete any workspace you own before deleting your account. Workspaces you only participate in will remain; your membership will be removed. Workspace-owned integrations and settings are not removed when a non-owner leaves.</p>
      <p className="subheading">If you are a platform administrator, another platform owner must revoke your administrator assignment first. Historical workspace records are retained, with your personal actor reference removed.</p>
    </section>
    <section className="panel team-panel">
      <div className="panel-heading"><div><p className="eyebrow">PERMANENT ACTION</p><h2>Confirm deletion</h2></div></div>
      <label htmlFor="account-delete-confirmation">Type {CONFIRMATION} to continue</label>
      <input id="account-delete-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" />
      <button className="secondary-button" disabled={busy || confirmation !== CONFIRMATION} onClick={() => void deleteAccount()}>{busy ? "Deleting account…" : "Permanently delete account"}</button>
      <p className="subheading">Your session will be revoked and you will be signed out when deletion succeeds.</p>
    </section>
    <footer className="footer"><a href="/account/data-exports">Back to account data</a><a href="/">Cancel</a></footer>
  </main>;
}
