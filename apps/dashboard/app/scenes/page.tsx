"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Workspace = { id: string; name: string; role: "owner" | "admin" | "moderator" | "viewer" };
type Scene = {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  token_created_at: string | null;
  token_revoked_at: string | null;
  has_active_access: boolean;
};
type SceneSecret = { sceneId: string; url: string };
type SceneEditor = { sceneId: string; name: string; draftState: Record<string, unknown>; draftRevision: number; publishedAt: string | null; updatedAt: string; hasPublishedState: boolean };
type SceneIssue = { scene: Scene; accessToken: string; overlayPath: string };

const API = "/api";
const OVERLAY_BASE = process.env.NEXT_PUBLIC_OVERLAY_BASE_URL;

function csrfToken() {
  return document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? "";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.method) headers.set("x-csrf-token", csrfToken());
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers,
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    const message = response.status === 401
      ? "Sign in to manage overlay scenes."
      : response.status === 403
        ? "You need workspace administrator permissions to manage scenes."
        : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function previewPercent(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function obsUrl(path: string, token: string) {
  const base = (OVERLAY_BASE || window.location.origin).replace(/\/+$/, "");
  return `${base}${path}#${token}`;
}

export default function ScenesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [name, setName] = useState("Now Playing");
  const [secrets, setSecrets] = useState<SceneSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<SceneEditor | null>(null);
  const [draftText, setDraftText] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);
  const starterRequests = useRef(new Set<string>());

  const loadScenes = useCallback(async () => {
    if (!workspaceId) {
      setScenes([]);
      return;
    }
    setError("");
    try {
      setScenes(await request<Scene[]>(`/workspaces/${workspaceId}/scenes`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load scenes.");
    }
  }, [workspaceId]);

  useEffect(() => {
    request<Workspace[]>("/workspaces")
      .then((available) => {
        setWorkspaces(available);
        setWorkspaceId(available[0]?.id ?? "");
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load workspaces."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { void loadScenes(); }, [loadScenes]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const canManage = selectedWorkspace && ["owner", "admin"].includes(selectedWorkspace.role);

  useEffect(() => {
    if (!workspaceId || !canManage || starterRequests.current.has(workspaceId)) return;
    starterRequests.current.add(workspaceId);
    request<SceneIssue & { accessToken: string | null; created: boolean }>(
      `/workspaces/${workspaceId}/scenes/starter`,
      { method: "POST" },
    )
      .then(async (result) => {
        if (result.created && result.accessToken) {
          setSecrets((current) => [
            ...current.filter((secret) => secret.sceneId !== result.scene.id),
            { sceneId: result.scene.id, url: obsUrl(result.overlayPath, result.accessToken as string) },
          ]);
          setMessage("Your starter Now Playing scene is ready. Copy its OBS URL now; the access token is shown only once.");
        }
        await loadScenes();
      })
      .catch((cause) => {
        starterRequests.current.delete(workspaceId);
        setError(cause instanceof Error ? cause.message : "Could not prepare the starter scene.");
      });
  }, [workspaceId, canManage, loadScenes]);

  function rememberSecret(sceneId: string, overlayPath: string, accessToken: string) {
    setSecrets((current) => [
      ...current.filter((secret) => secret.sceneId !== sceneId),
      { sceneId, url: obsUrl(overlayPath, accessToken) },
    ]);
  }

  async function createScene(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await request<SceneIssue>(`/workspaces/${workspaceId}/scenes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      rememberSecret(result.scene.id, result.overlayPath, result.accessToken);
      setName("");
      setMessage("Scene created. Copy its OBS URL now; the access token is shown only once.");
      await loadScenes();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the scene.");
    } finally {
      setBusy(false);
    }
  }

  async function rotateToken(scene: Scene) {
    if (!workspaceId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await request<SceneIssue>(`/workspaces/${workspaceId}/scenes/${scene.id}/access-token`, { method: "POST" });
      rememberSecret(scene.id, result.overlayPath, result.accessToken);
      setMessage(`A new OBS URL was issued for ${scene.name}. The previous token is invalid immediately.`);
      await loadScenes();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rotate the scene token.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(scene: Scene) {
    if (!workspaceId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await request(`/workspaces/${workspaceId}/scenes/${scene.id}/access-token`, { method: "DELETE" });
      setSecrets((current) => current.filter((secret) => secret.sceneId !== scene.id));
      setMessage(`OBS access revoked for ${scene.name}.`);
      await loadScenes();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke the scene token.");
    } finally {
      setBusy(false);
    }
  }

  async function openEditor(scene: Scene) {
    if (!workspaceId) return;
    setEditorBusy(true);
    setError("");
    try {
      const result = await request<SceneEditor>(`/workspaces/${workspaceId}/scenes/${scene.id}/editor`);
      setEditor(result);
      setDraftText(JSON.stringify(result.draftState, null, 2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the scene editor.");
    } finally {
      setEditorBusy(false);
    }
  }

  const previewState = (() => {
    try {
      const parsed: unknown = JSON.parse(draftText);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  })();
  const previewElements = previewState && Array.isArray(previewState.elements)
    ? previewState.elements.filter((element): element is Record<string, unknown> =>
        typeof element === "object" && element !== null && !Array.isArray(element),
      )
    : [];

  async function saveDraft() {
    if (!editor || !workspaceId || !previewState) {
      setError("Fix the JSON document before saving the draft.");
      return;
    }
    setEditorBusy(true);
    setError("");
    try {
      const saved = await request<{ draftState: Record<string, unknown>; draftRevision: number; updatedAt: string }>(
        `/workspaces/${workspaceId}/scenes/${editor.sceneId}/draft`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: previewState, expectedRevision: editor.draftRevision }),
        },
      );
      setEditor({ ...editor, draftState: saved.draftState, draftRevision: saved.draftRevision, updatedAt: saved.updatedAt });
      setDraftText(JSON.stringify(saved.draftState, null, 2));
      setMessage("Draft saved. The OBS overlay remains on its previously published state.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the draft.");
    } finally {
      setEditorBusy(false);
    }
  }

  async function publishDraft() {
    if (!editor || !workspaceId || !previewState) {
      setError("Save a valid draft before publishing.");
      return;
    }
    if (JSON.stringify(previewState) !== JSON.stringify(editor.draftState)) {
      setError("Save your latest draft changes before publishing.");
      return;
    }
    setEditorBusy(true);
    setError("");
    try {
      const saved = await request<{ publishedAt: string; publishedRevision: number }>(
        `/workspaces/${workspaceId}/scenes/${editor.sceneId}/publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: editor.draftRevision }),
        },
      );
      setEditor({ ...editor, publishedAt: saved.publishedAt, hasPublishedState: true });
      setMessage("Draft published. Connected OBS overlays will reload the published scene.");
      await loadScenes();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not publish the scene.");
    } finally {
      setEditorBusy(false);
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("OBS browser-source URL copied.");
    } catch {
      setMessage("Clipboard access was unavailable. Select and copy the URL shown below.");
    }
  }

  return <main className="shell">
    <header className="topbar">
      <a className="brand" href="/">♫ Streamer Audio</a>
      <nav className="page-nav"><a href="/">Dashboard</a><a href="/team">Team</a><a href="/notifications">Notifications</a><a href="/settings">Settings</a></nav>
    </header>
    <section className="welcome">
      <div><p className="eyebrow">HOSTED OBS OVERLAYS</p><h1>Scenes</h1><p className="subheading">Each scene has its own stable path and independently revocable read-only access token. Set NEXT_PUBLIC_OVERLAY_BASE_URL to the hosted overlay origin when it is deployed separately.</p></div>
    </section>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {message && <p role="status">{message}</p>}
    {loading ? <div className="panel">Loading workspaces…</div> : <>
      <div className="scene-toolbar">
        <label>WORKSPACE<select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setSecrets([]); }}>
          {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select></label>
      </div>
      {canManage && <section className="panel team-panel">
        <div className="panel-heading"><div><p className="eyebrow">NEW SCENE</p><h2>Create an OBS scene</h2></div></div>
        <form className="scene-create" onSubmit={(event) => void createScene(event)}>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Scene name" aria-label="Scene name" required />
          <button type="submit" className="primary-button" disabled={busy || !name.trim()}>{busy ? "Working…" : "Create scene"}</button>
        </form>
      </section>}
      <section className="panel team-panel">
        <div className="panel-heading"><div><p className="eyebrow">WORKSPACE SCENES</p><h2>Overlay access</h2></div><button type="button" className="secondary-button" disabled={busy} onClick={() => void loadScenes()}>Refresh</button></div>
        {scenes.length ? <div className="scene-list">{scenes.map((scene) => {
          const secret = secrets.find((item) => item.sceneId === scene.id);
          return <article className="scene-row" key={scene.id}>
            <div className="scene-row-main">
              <strong>{scene.name}</strong>
              <span className={scene.has_active_access ? "scene-status is-active" : "scene-status is-revoked"}>{scene.has_active_access ? "Access active" : "Access revoked"}</span>
              <small>Stable scene path: /scene/{scene.id}</small>
              {secret && <div className="scene-secret">
                <strong>New OBS browser-source URL</strong>
                <p>This secret is held only in this page until you leave or refresh. Copy it into OBS now. It is not stored in plaintext by the platform.</p>
                <input aria-label={`OBS URL for ${scene.name}`} readOnly value={secret.url} onFocus={(event) => event.currentTarget.select()} />
                <div className="scene-secret-actions"><button type="button" className="secondary-button" onClick={() => void copyUrl(secret.url)}>Copy OBS URL</button></div>
              </div>}
            </div>
            {canManage && <div className="scene-row-actions">
              <button type="button" className="secondary-button" disabled={busy || editorBusy} onClick={() => void openEditor(scene)}>Edit scene</button>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void rotateToken(scene)}>Issue new token</button>
              {scene.has_active_access && <button type="button" className="text-button danger-text" disabled={busy} onClick={() => void revokeToken(scene)}>Revoke access</button>}
            </div>}
          </article>;
        })}</div> : <div className="quiet-empty"><span>♫</span><p>No scenes have been created for this workspace.</p><small>Create a scene to issue its first OBS access URL.</small></div>}
      </section>
      
      {editor && <section className="panel team-panel scene-editor-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">SCENE EDITOR</p><h2>{editor.name}</h2><small>Draft revision {editor.draftRevision} · {editor.hasPublishedState ? "A published version is live" : "Nothing published yet"}</small></div>
          <button type="button" className="secondary-button" onClick={() => setEditor(null)}>Close editor</button>
        </div>
        <div className="scene-editor-grid">
          <div className="scene-draft-column">
            <label htmlFor="scene-draft-json">DRAFT DOCUMENT (JSON)</label>
            <textarea id="scene-draft-json" value={draftText} onChange={(event) => setDraftText(event.target.value)} spellCheck={false} rows={18} />
            <div className="scene-editor-actions">
              <button type="button" className="secondary-button" disabled={editorBusy || !previewState} onClick={() => void saveDraft()}>{editorBusy ? "Working…" : "Save draft"}</button>
              <button type="button" className="primary-button" disabled={editorBusy || !previewState} onClick={() => void publishDraft()}>Publish draft</button>
            </div>
            <small>Saving changes only the private draft. Publishing is a separate, explicit action.</small>
          </div>
          <div className="scene-preview-column">
            <div className="scene-preview-heading"><strong>Live draft preview</strong><span>LOCAL · UNSAVED CHANGES</span></div>
            <div className="scene-preview-canvas">
              <div className="scene-preview-stage">
                {previewElements.map((element, index) => {
                  const left = previewPercent(element.x, 5 + (index % 3) * 30, 0, 99);
                  const top = previewPercent(element.y, 8 + Math.floor(index / 3) * 28, 0, 99);
                  const width = previewPercent(element.width, 28, 1, 100 - left);
                  const height = previewPercent(element.height, 18, 1, 100 - top);
                  const label = typeof element.text === "string"
                    ? element.text
                    : typeof element.name === "string"
                      ? element.name
                      : "Preview element";
                  return <div
                    className="scene-preview-element"
                    key={typeof element.id === "string" ? element.id : index}
                    style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
                  >
                    <small>{typeof element.type === "string" ? element.type : "Component"}</small>
                    <span>{label}</span>
                  </div>;
                })}
                {previewElements.length === 0 && <div className="scene-preview-empty">Empty scene · add components in the next editor milestone</div>}
              </div>
            </div>
            <small>Preview reflects the editor buffer immediately. It is not served to OBS until you publish.</small>
          </div>
        </div>
      </section>}

    </>}
    <footer className="footer"><span>Hosted overlay scenes</span><a href="/">Back to dashboard</a></footer>
  </main>;
}
