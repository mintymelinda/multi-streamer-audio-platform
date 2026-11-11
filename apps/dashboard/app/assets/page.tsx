"use client";

import { useCallback, useEffect, useState } from "react";

type Workspace = { id: string; name: string; role: "owner" | "admin" | "moderator" | "viewer" };
type Asset = { id: string; name: string; folder: string; contentType: string; size: number; width: number; height: number; url: string };

const API = "/api";

function csrfToken() {
  return document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? "";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.method) headers.set("x-csrf-token", csrfToken());
  const response = await fetch(`${API}${path}`, { ...init, headers, credentials: "include", cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string; usage?: unknown } | null;
    throw Object.assign(new Error(body?.message ?? `Request failed (${response.status}).`), { status: response.status, body });
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export default function AssetsPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [folder, setFolder] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [assetName, setAssetName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [usage, setUsage] = useState<{ assetId: string; scenes: { sceneId: string; sceneName: string; draft: boolean; published: boolean }[] } | null>(null);

  const canManage = workspaces.find((item) => item.id === workspaceId)?.role === "owner"
    || workspaces.find((item) => item.id === workspaceId)?.role === "admin";

  const loadAssets = useCallback(async () => {
    if (!workspaceId) { setAssets([]); return; }
    try {
      setAssets(await request<Asset[]>(`/workspaces/${workspaceId}/assets?folder=${encodeURIComponent(folder)}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load assets.");
    }
  }, [workspaceId, folder]);

  useEffect(() => {
    request<Workspace[]>("/workspaces")
      .then((items) => { setWorkspaces(items); setWorkspaceId(items[0]?.id ?? ""); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load workspaces."));
  }, []);

  useEffect(() => { void loadAssets(); }, [loadAssets]);

  async function upload() {
    if (!workspaceId || !file) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const intent = await request<{ uploadUrl: string; headers: Record<string, string>; completePath: string }>(
        `/workspaces/${workspaceId}/assets/upload-intent`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: assetName.trim() || file.name, folder, contentType: file.type }) },
      );
      const uploaded = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: file });
      if (!uploaded.ok) throw new Error(`Object storage upload failed (${uploaded.status}). Check the configured public storage endpoint and bucket CORS policy.`);
      await request(intent.completePath, { method: "POST" });
      setFile(null); setAssetName(""); setMessage("Asset uploaded and verified.");
      await loadAssets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload asset.");
    } finally { setBusy(false); }
  }

  async function replace(asset: Asset, replacement: File | null) {
    if (!replacement || !workspaceId) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const intent = await request<{ uploadUrl: string; headers: Record<string, string>; completePath: string }>(
        `/workspaces/${workspaceId}/assets/${asset.id}/replacement-upload`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contentType: replacement.type }) },
      );
      const uploaded = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: replacement });
      if (!uploaded.ok) throw new Error(`Object storage upload failed (${uploaded.status}).`);
      await request(intent.completePath, { method: "POST" });
      setMessage(`Replaced ${asset.name}; existing scene references were retained.`);
      await loadAssets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not replace asset.");
    } finally { setBusy(false); }
  }

  async function rename(asset: Asset) {
    const name = window.prompt("Asset name", asset.name);
    if (name === null || !name.trim()) return;
    setBusy(true); setError("");
    try {
      await request(`/workspaces/${workspaceId}/assets/${asset.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      await loadAssets();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not rename asset."); }
    finally { setBusy(false); }
  }

  async function remove(asset: Asset) {
    setBusy(true); setError("");
    try {
      await request(`/workspaces/${workspaceId}/assets/${asset.id}`, { method: "DELETE" });
      setUsage(null); setMessage(`Deleted ${asset.name}.`); await loadAssets();
    } catch (cause) {
      const failure = cause as Error & { status?: number; body?: { usage?: { sceneId: string; sceneName: string; draft: boolean; published: boolean }[] } };
      if (failure.status === 409 && failure.body?.usage) setUsage({ assetId: asset.id, scenes: failure.body.usage });
      else setError(failure.message);
    } finally { setBusy(false); }
  }

  const folders = [...new Set(assets.map((asset) => asset.folder).filter(Boolean))].sort();

  return <main className="shell">
    <header className="topbar"><a className="brand" href="/">♫ Streamer Audio</a><nav className="page-nav"><a href="/">Dashboard</a><a href="/scenes">Scenes</a><a href="/team">Team</a><a href="/settings">Settings</a></nav></header>
    <section className="welcome"><div><p className="eyebrow">WORKSPACE MEDIA</p><h1>Asset library</h1><p className="subheading">Upload images once, organize them into folders, and reuse them across scenes. Replacing an asset preserves its scene references.</p></div></section>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {message && <p role="status">{message}</p>}
    <section className="panel team-panel">
      <div className="panel-heading"><div><p className="eyebrow">ASSET WORKSPACE</p><h2>Workspace library</h2></div><button className="secondary-button" type="button" disabled={busy} onClick={() => void loadAssets()}>Refresh</button></div>
      <label>WORKSPACE<select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setFolder(""); setUsage(null); }}>{workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="scene-layout-toolbar">
        <label>Folder<select value={folder} onChange={(event) => setFolder(event.target.value)}><option value="">Root</option>{folders.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>Open folder path<input value={newFolder} onChange={(event) => setNewFolder(event.target.value)} placeholder="branding / overlays" /></label>
        <button type="button" className="secondary-button" onClick={() => setFolder(newFolder.split("/").map((part) => part.trim()).filter(Boolean).join("/"))}>Open folder</button>
      </div>
      {canManage && <div className="scene-create">
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => setFile(event.target.files?.[0] ?? null)} aria-label="Choose image file" />
        <input value={assetName} onChange={(event) => setAssetName(event.target.value)} placeholder="Asset name (optional)" aria-label="Asset name" />
        <button type="button" className="primary-button" disabled={busy || !file} onClick={() => void upload()}>{busy ? "Working…" : "Upload image"}</button>
      </div>}
      <div className="scene-list">
        {assets.map((asset) => <article className="scene-row" key={asset.id}>
          <img src={asset.url} alt={asset.name} width={96} height={72} style={{ objectFit: "contain", background: "#171923", borderRadius: 6 }} />
          <div className="scene-row-main"><strong>{asset.name}</strong><small>{asset.width} × {asset.height} · {(asset.size / 1024).toFixed(1)} KiB · {asset.folder || "Root"}</small></div>
          {canManage && <div className="scene-row-actions">
            <button type="button" className="text-button" disabled={busy} onClick={() => void rename(asset)}>Rename</button>
            <label className="text-button">Replace<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden disabled={busy} onChange={(event) => void replace(asset, event.target.files?.[0] ?? null)} /></label>
            <button type="button" className="text-button danger-text" disabled={busy} onClick={() => void remove(asset)}>Delete</button>
          </div>}
        </article>)}
        {assets.length === 0 && <div className="quiet-empty"><span>▧</span><p>No assets in this folder yet.</p><small>Upload PNG, JPEG, WebP, or GIF files up to 10 MiB.</small></div>}
      </div>
    </section>
    {usage && <section className="panel team-panel"><h2>Asset is in use</h2><p>This asset cannot be deleted until its references are removed from these scenes.</p><ul>{usage.scenes.map((scene) => <li key={scene.sceneId}>{scene.sceneName} — {scene.draft ? "draft" : ""}{scene.draft && scene.published ? " and " : ""}{scene.published ? "published" : ""}</li>)}</ul><button type="button" className="secondary-button" onClick={() => setUsage(null)}>Close</button></section>}
    <footer className="footer"><span>Workspace asset library</span><a href="/scenes">Back to scenes</a></footer>
  </main>;
}
