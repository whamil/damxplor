import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RestDataProvider } from "@svar-ui/filemanager-data-provider";
import {
  Filemanager,
  Tooltip,
  Willow,
  WillowDark,
  getMenuOptions,
} from "@svar-ui/react-filemanager";
import "@svar-ui/react-filemanager/all.css";

import { getData } from "./common/data";

const restProvider = new RestDataProvider("/api/nas/rest");
const providerListenerTag = {};

const modes = [
  { id: "cards", label: "Cards", icon: "▦" },
  { id: "table", label: "Table", icon: "☷" },
  { id: "panels", label: "Panels", icon: "◫" },
];

const panelPresets = {
  workspace: [
    { path: "/NAS", selected: [] },
    { path: "/NAS/00 Project Archive/2026/[Event Name]", selected: [] },
  ],
  company: [
    { path: "/NAS/01 Reference Files", selected: [] },
    { path: "/NAS/02 Company Documents", selected: [] },
  ],
};

function formatBytes(bytes = 0) {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function FileTooltip({ data }) {
  const { file } = data;

  return (
    <div className="file-tooltip">
      <strong>{file.name}</strong>
      <span>{file.type === "folder" ? "Folder" : file.ext?.toUpperCase() || "File"}</span>
      <span>{file.type === "folder" ? "Open to view contents" : formatBytes(file.size)}</span>
      {file.tag && (
        <span className="tooltip-tag"><i style={{ background: file.tag }} />{file.clientCode} · {file.clientName}</span>
      )}
      {file.label && (
        <span className="tooltip-tag"><i style={{ background: file.labelColor }} />{file.label}</span>
      )}
    </div>
  );
}

function createIconSvg(symbol, color, background) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="${background}"/><text x="32" y="40" text-anchor="middle" font-family="Arial,sans-serif" font-size="27" font-weight="700" fill="${color}">${symbol}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const designIcon = createIconSvg("✦", "#7c3aed", "#ede9fe");
const imageIcon = createIconSvg("◉", "#0284c7", "#e0f2fe");

function customIcons(file, size) {
  if (file.labelColor) return createIconSvg("●", file.labelColor, `${file.labelColor}22`);
  if (file.tag) return createIconSvg(file.clientCode?.slice(0, 2) || "P", file.tag, `${file.tag}22`);
  if (file.id?.includes("Presentations") || file.id?.includes("Deck")) return designIcon;
  if (file.id?.includes("Photo") || file.id?.includes("Coverage")) return imageIcon;
  if (file.type === "folder") return false;

  const supported = new Set([
    "doc", "docx", "xls", "xlsx", "txt", "pdf", "md", "svg", "png", "jpg", "jpeg", "fig",
  ]);
  const extension = supported.has(file.ext) ? file.ext : "file";
  return `https://cdn.svar.dev/icons/filemanager/vivid/${size}/${extension}.svg`;
}

export default function App() {
  const managerRef = useRef(null);
  const uploadInputRef = useRef(null);
  const [data, setData] = useState(getData);
  const [drive, setDrive] = useState({ used: 0, total: 0 });
  const [api, setApi] = useState(null);
  const [mode, setMode] = useState("table");
  const [panelPreset, setPanelPreset] = useState("workspace");
  const [activePanel, setActivePanel] = useState(0);
  const [iconStyle, setIconStyle] = useState("custom");
  const [theme, setTheme] = useState("willow");
  const [serialized, setSerialized] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [folderBrowser, setFolderBrowser] = useState(null);
  const [folderBrowserBusy, setFolderBrowserBusy] = useState(false);
  const [folderBrowserError, setFolderBrowserError] = useState("");
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState("");
  const [projectCreated, setProjectCreated] = useState("");
  const [syncNotice, setSyncNotice] = useState(null);
  const [selection, setSelection] = useState([]);
  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const [labelBusy, setLabelBusy] = useState(false);
  const [labelForm, setLabelForm] = useState({ name: "Review", color: "#F59E0B" });
  const [project, setProject] = useState({
    date: new Date().toISOString().slice(0, 10),
    eventName: "",
    clientCode: "",
  });
  const [settings, setSettings] = useState({
    path: "",
    displayName: "NAS",
    includeHidden: false,
    maxDepth: 12,
    readonly: false,
    clients: [],
    projects: [],
  });

  const panels = useMemo(() => {
    const rootId = data[0]?.id || "/";
    const preset = panelPresets[panelPreset];
    if (rootId === "/NAS" && preset.every((panel) => data.some((item) => item.id === panel.path))) {
      return preset;
    }
    return [
      { path: rootId, selected: [] },
      { path: rootId, selected: [] },
    ];
  }, [data, panelPreset]);

  const loadNasFiles = useCallback(async () => {
    const [files, info] = await Promise.all([
      restProvider.loadFiles(),
      restProvider.loadInfo(),
    ]);
    if (!Array.isArray(files)) throw new Error("Unable to load files from the NAS server");
    setData(files);
    setDrive(info?.stats || { used: 0, total: 0 });
    setConnected(true);
    return { files, drive: info?.stats };
  }, []);

  const loadDynamicFolder = useCallback(async ({ id }) => {
    try {
      const children = await restProvider.loadFiles(id);
      if (!Array.isArray(children)) throw new Error("Unable to load folder contents");
      await managerRef.current?.exec("provide-data", { id, data: children });
    } catch (error) {
      setSyncNotice({ type: "error", text: error.message });
    }
  }, []);

  const initializeFilemanager = useCallback((managerApi) => {
    setApi(managerApi);
    const getDirectLink = (id, download = false) => (
      `/api/nas/direct?id=${encodeURIComponent(id)}${download ? "&download=true" : ""}`
    );

    managerApi.on("open-file", ({ id }) => {
      const opened = window.open(getDirectLink(id), "_blank", "noopener,noreferrer");
      if (!opened) setSyncNotice({ type: "error", text: "Allow pop-ups to open this file." });
    });

    managerApi.on("download-file", ({ id }) => {
      const link = document.createElement("a");
      link.href = getDirectLink(id, true);
      link.download = "";
      document.body.appendChild(link);
      link.click();
      link.remove();
    });

    restProvider.detach(providerListenerTag);
    restProvider.on("file-renamed", ({ id, newId }) => {
      managerApi.exec("rename-file", {
        id,
        name: newId.split("/").pop(),
        skipProvider: true,
      });
    }, { tag: providerListenerTag });
    managerApi.setNext(restProvider);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/nas/settings")
      .then((response) => response.json())
      .then(async (saved) => {
        if (cancelled) return;
        setSettings(saved);
        if (saved.path) await loadNasFiles();
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => { cancelled = true; };
  }, [loadNasFiles]);

  const menuOptions = useCallback((context, item) => {
    const options = getMenuOptions(context);

    if (context === "file" && item?.ext === "md") {
      return options.filter((option) => option.id !== "download");
    }

    if (context === "multiselect") {
      return options.filter((option) => option.id !== "move");
    }

    return options;
  }, []);

  const captureSelection = useCallback(() => {
    queueMicrotask(() => {
      const state = managerRef.current?.getState();
      const panel = state?.panels?.[state.activePanel];
      setSelection(panel?.selected ? [...panel.selected] : []);
    });
  }, []);

  function changeMode(nextMode) {
    setMode(nextMode);
    api?.exec("set-mode", { mode: nextMode });
  }

  function changePanelPreset(event) {
    setPanelPreset(event.target.value);
    setActivePanel(0);
    setMode("panels");
  }

  function serializeFiles() {
    const structure = managerRef.current?.serialize("/") ?? [];
    setSerialized(structure);
  }

  function collapseAllFolders() {
    const items = managerRef.current?.serialize("/") || [];
    items.filter((item) => item.type === "folder").forEach((item) => {
      managerRef.current?.exec("open-tree-folder", { id: item.id, mode: false });
    });
  }

  async function uploadSelectedFiles(event) {
    const files = [...event.target.files];
    const state = managerRef.current?.getState();
    const parent = state?.panels?.[state.activePanel]?.path;
    if (!parent || !files.length) return;
    try {
      for (const file of files) {
        await managerRef.current.exec("create-file", {
          parent,
          file: { name: file.name, size: file.size, date: new Date(), type: "file", file },
        });
      }
      setSyncNotice({ type: "success", text: `${files.length} file${files.length > 1 ? "s" : ""} uploaded` });
      window.setTimeout(() => setSyncNotice(null), 1800);
    } catch (error) {
      setSyncNotice({ type: "error", text: error.message || "Upload failed" });
    } finally {
      event.target.value = "";
    }
  }

  function selectedDirectLink() {
    const item = selection.length === 1 ? managerRef.current?.getFile(selection[0]) : null;
    if (!item || item.type !== "file") return "";
    return `${window.location.origin}/api/nas/direct?id=${encodeURIComponent(item.id)}`;
  }

  async function copySelectedLink() {
    const link = selectedDirectLink();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setSyncNotice({ type: "success", text: "File link copied" });
      window.setTimeout(() => setSyncNotice(null), 1800);
    } catch {
      window.prompt("Copy file link", link);
    }
  }

  async function shareSelectedFile() {
    const link = selectedDirectLink();
    if (!link) return;
    const item = managerRef.current?.getFile(selection[0]);
    if (navigator.share) {
      try {
        await navigator.share({ title: item?.name || "Shared file", url: link });
      } catch (error) {
        if (error.name !== "AbortError") setSyncNotice({ type: "error", text: "Unable to share file" });
      }
    } else {
      await copySelectedLink();
    }
  }

  async function deleteSelectedItems() {
    if (!selection.length || !window.confirm(`Delete ${selection.length} selected item${selection.length > 1 ? "s" : ""}?`)) return;
    await managerRef.current?.exec("delete-files", { ids: selection });
    setSelection([]);
  }

  async function applySelectedLabel(event) {
    event.preventDefault();
    setLabelBusy(true);
    try {
      const response = await fetch("/api/nas/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selection, ...labelForm }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to apply label");
      await loadNasFiles();
      setLabelDialogOpen(false);
      setSelection([]);
      setSyncNotice({ type: "success", text: `Label “${labelForm.name}” applied` });
      window.setTimeout(() => setSyncNotice(null), 1800);
    } catch (error) {
      setSyncNotice({ type: "error", text: error.message });
    } finally {
      setLabelBusy(false);
    }
  }

  async function saveNasSettings(event) {
    event.preventDefault();
    setSettingsBusy(true);
    setSettingsError("");
    try {
      const response = await fetch("/api/nas/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to save NAS settings");
      setSettings(result.settings);
      setData(result.files.map((item) => ({ ...item, date: new Date(item.date) })));
      setDrive(result.drive || drive);
      setConnected(true);
      setSettingsOpen(false);
      setActivePanel(0);
    } catch (error) {
      setConnected(false);
      setSettingsError(error.message);
    } finally {
      setSettingsBusy(false);
    }
  }

  async function browseFolder(folderPath = "") {
    setFolderBrowserBusy(true);
    setFolderBrowserError("");
    try {
      const query = folderPath ? `?path=${encodeURIComponent(folderPath)}` : "";
      const response = await fetch(`/api/nas/directories${query}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to browse this location");
      setFolderBrowser(result);
    } catch (error) {
      setFolderBrowserError(error.message);
    } finally {
      setFolderBrowserBusy(false);
    }
  }

  function openFolderBrowser() {
    setFolderBrowser({ path: settings.path || "", parent: null, directories: [] });
    browseFolder(settings.path);
  }

  function selectBrowsedFolder() {
    setSettings({ ...settings, path: folderBrowser.path });
    setFolderBrowser(null);
    setSettingsError("");
  }

  function addClient() {
    setSettings({
      ...settings,
      clients: [...(settings.clients || []), { name: "", code: "", tag: "#2563EB" }],
    });
  }

  function updateClient(index, field, value) {
    const clients = settings.clients.map((client, clientIndex) => (
      clientIndex === index ? { ...client, [field]: value } : client
    ));
    setSettings({ ...settings, clients });
  }

  function removeClient(index) {
    setSettings({ ...settings, clients: settings.clients.filter((_, clientIndex) => clientIndex !== index) });
  }

  function openProjectDialog() {
    if (!connected) {
      setSettingsError("Connect a NAS folder before creating a project.");
      setSettingsOpen(true);
      return;
    }
    setProjectError("");
    setProjectCreated("");
    if (!project.clientCode && settings.clients?.length) {
      setProject({ ...project, clientCode: settings.clients[0].code });
    }
    setProjectDialogOpen(true);
  }

  async function createProject(event) {
    event.preventDefault();
    setProjectBusy(true);
    setProjectError("");
    try {
      const response = await fetch("/api/nas/create-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to create project folders");
      setData(result.files.map((item) => ({ ...item, date: new Date(item.date) })));
      if (result.drive) setDrive(result.drive);
      setProjectCreated(result.createdPath);
      setProject({ ...project, eventName: "" });
    } catch (error) {
      setProjectError(error.message);
    } finally {
      setProjectBusy(false);
    }
  }

  return (
    <main className={`app-shell ${theme === "dark" ? "app-dark" : ""}`}>
      <header className="app-header">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>File Manager</h1>
        </div>
        <div className="header-actions">
          {settings.readonly && <span className="readonly-badge">Read only</span>}
          <span className={`status ${connected ? "connected" : "demo"}`}>
            {connected ? "NAS connected" : "Template data"}
          </span>
          <button className="admin-button" type="button" onClick={() => setSettingsOpen(true)}>
            ⚙ Admin settings
          </button>
        </div>
      </header>

      <section className="control-bar" aria-label="File manager settings">
        <div className="control-group" aria-label="Display mode">
          <span className="control-label">View</span>
          <div className="segmented-control">
            {modes.map((item) => (
              <button
                className={mode === item.id ? "active" : ""}
                key={item.id}
                onClick={() => changeMode(item.id)}
                type="button"
              >
                <span aria-hidden="true">{item.icon}</span> {item.label}
              </button>
            ))}
          </div>
        </div>

        <label className="select-control">
          <span className="control-label">Panel folders</span>
          <select value={panelPreset} onChange={changePanelPreset}>
            <option value="workspace">NAS + Current Event</option>
            <option value="company">References + Company</option>
          </select>
        </label>

        <label className="select-control">
          <span className="control-label">Theme</span>
          <select value={theme} onChange={(event) => setTheme(event.target.value)}>
            <option value="willow">Willow</option>
            <option value="dark">Willow Dark</option>
          </select>
        </label>

        <label className="select-control">
          <span className="control-label">Icons</span>
          <select value={iconStyle} onChange={(event) => setIconStyle(event.target.value)}>
            <option value="custom">Custom + vivid</option>
            <option value="simple">Default simple</option>
          </select>
        </label>

        <button className="export-button" type="button" onClick={serializeFiles}>
          Export structure
        </button>
        <button
          className="create-project-button"
          type="button"
          onClick={openProjectDialog}
          disabled={settings.readonly}
          title={settings.readonly ? "Disable read-only mode in Admin Settings to create projects" : ""}
        >
          + Create Project Folders
        </button>
      </section>

      <nav className="action-toolbar" aria-label="File actions">
        <button type="button" onClick={collapseAllFolders} title="Collapse every folder in the navigation pane">
          <span>⊟</span> Collapse all
        </button>
        <span className="toolbar-divider" />
        <button type="button" disabled={settings.readonly} onClick={() => uploadInputRef.current?.click()}>
          <span>↑</span> Upload
        </button>
        <button type="button" disabled={!selectedDirectLink()} onClick={shareSelectedFile}>
          <span>↗</span> Share
        </button>
        <button type="button" disabled={!selectedDirectLink()} onClick={copySelectedLink}>
          <span>🔗</span> Get link
        </button>
        <button type="button" disabled={settings.readonly || !selection.length} onClick={() => setLabelDialogOpen(true)}>
          <span>●</span> Labels
        </button>
        <button className="danger" type="button" disabled={settings.readonly || !selection.length} onClick={deleteSelectedItems}>
          <span>⌫</span> Delete
        </button>
        <span className="selection-count">{selection.length ? `${selection.length} selected` : "No selection"}</span>
        <input ref={uploadInputRef} type="file" multiple hidden onChange={uploadSelectedFiles} />
      </nav>

      <section className="filemanager-card" aria-label="File manager">
        {(() => {
          const Theme = theme === "dark" ? WillowDark : Willow;
          return <Theme>
          <Filemanager
            ref={managerRef}
            data={data}
            drive={drive}
            readonly={settings.readonly}
            mode={mode}
            panels={panels}
            activePanel={activePanel}
            preview
            menuOptions={menuOptions}
            icons={iconStyle === "simple" ? "simple" : customIcons}
            init={initializeFilemanager}
            onSetMode={({ mode: nextMode }) => setMode(nextMode)}
            onSetActivePanel={({ panel }) => { setActivePanel(panel); captureSelection(); }}
            onSelectFile={captureSelection}
            onSetPath={captureSelection}
            onRequestData={loadDynamicFolder}
          />
          <Tooltip api={api} content={FileTooltip} at="bottom" />
          </Theme>;
        })()}
      </section>

      {syncNotice && (
        <div className={`sync-notice ${syncNotice.type}`} role="status">
          {syncNotice.type === "working" ? "↻" : syncNotice.type === "success" ? "✓" : "!"}
          <span>{syncNotice.text}</span>
          {syncNotice.type === "error" && (
            <button type="button" aria-label="Dismiss" onClick={() => setSyncNotice(null)}>×</button>
          )}
        </div>
      )}

      {labelDialogOpen && (
        <div className="export-backdrop" role="presentation" onMouseDown={() => setLabelDialogOpen(false)}>
          <form className="label-dialog" onSubmit={applySelectedLabel} onMouseDown={(event) => event.stopPropagation()}>
            <div className="export-heading">
              <div>
                <p className="eyebrow">{selection.length} selected</p>
                <h2>Apply label</h2>
              </div>
              <button type="button" aria-label="Close" onClick={() => setLabelDialogOpen(false)}>×</button>
            </div>
            <label className="settings-field">
              <span>Label name</span>
              <input required autoFocus value={labelForm.name} onChange={(event) => setLabelForm({ ...labelForm, name: event.target.value })} />
            </label>
            <label className="label-color-field">
              <span>Color</span>
              <input type="color" value={labelForm.color} onChange={(event) => setLabelForm({ ...labelForm, color: event.target.value })} />
              <code>{labelForm.color.toUpperCase()}</code>
            </label>
            <div className="settings-actions">
              <button type="button" onClick={() => setLabelDialogOpen(false)}>Cancel</button>
              <button className="save-settings" type="submit" disabled={labelBusy}>{labelBusy ? "Applying…" : "Apply label"}</button>
            </div>
          </form>
        </div>
      )}

      {serialized && (
        <div className="export-backdrop" role="presentation" onMouseDown={() => setSerialized(null)}>
          <section
            className="export-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="export-heading">
              <div>
                <p className="eyebrow">Serialized data</p>
                <h2 id="export-title">Current file structure</h2>
              </div>
              <button type="button" aria-label="Close" onClick={() => setSerialized(null)}>×</button>
            </div>
            <p>{serialized.length} items exported as a plain array.</p>
            <pre>{JSON.stringify(serialized, null, 2)}</pre>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="export-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <form
            className="settings-dialog"
            aria-labelledby="settings-title"
            onSubmit={saveNasSettings}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="export-heading">
              <div>
                <p className="eyebrow">Administrator</p>
                <h2 id="settings-title">NAS folder connection</h2>
              </div>
              <button type="button" aria-label="Close" onClick={() => setSettingsOpen(false)}>×</button>
            </div>

            <p className="settings-intro">
              Enter the path where the NAS share is mounted on this server. DAMXPLOR will browse beneath this folder only.
            </p>

            <label className="settings-field">
              <span>Mounted folder path</span>
              <div className="path-input-group">
                <input
                  required
                  value={settings.path}
                  onChange={(event) => setSettings({ ...settings, path: event.target.value })}
                  placeholder="/Volumes/NAS"
                  autoComplete="off"
                />
                <button type="button" onClick={openFolderBrowser}>Browse…</button>
              </div>
              <small>Examples: /Volumes/NAS, /mnt/company-nas, or a mounted SMB share.</small>
            </label>

            <div className="settings-row">
              <label className="settings-field">
                <span>Explorer name</span>
                <input
                  required
                  value={settings.displayName}
                  onChange={(event) => setSettings({ ...settings, displayName: event.target.value })}
                />
              </label>
              <label className="settings-field">
                <span>Scan depth</span>
                <input
                  type="number"
                  min="1"
                  max="30"
                  value={settings.maxDepth}
                  onChange={(event) => setSettings({ ...settings, maxDepth: Number(event.target.value) })}
                />
              </label>
            </div>

            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={settings.includeHidden}
                onChange={(event) => setSettings({ ...settings, includeHidden: event.target.checked })}
              />
              Show hidden files and folders
            </label>

            <label className="checkbox-field readonly-setting">
              <input
                type="checkbox"
                checked={settings.readonly}
                onChange={(event) => setSettings({ ...settings, readonly: event.target.checked })}
              />
              <span>
                <strong>Read-only mode</strong>
                <small>Users can browse, open, and download files, but cannot create, rename, move, copy, or delete.</small>
              </span>
            </label>

            <section className="client-settings" aria-labelledby="client-settings-title">
              <div className="client-settings-heading">
                <div>
                  <h3 id="client-settings-title">Clients</h3>
                  <p>Codes are used in project folder names; colors identify projects.</p>
                </div>
                <button type="button" onClick={addClient}>+ Add client</button>
              </div>

              <div className="client-table">
                <div className="client-table-head">
                  <span>Client Name</span><span>Code</span><span>Tag</span><span />
                </div>
                {settings.clients?.map((client, index) => (
                  <div className="client-row" key={index}>
                    <input
                      required
                      aria-label="Client name"
                      value={client.name}
                      onChange={(event) => updateClient(index, "name", event.target.value)}
                      placeholder="Client name"
                    />
                    <input
                      required
                      aria-label="Client code"
                      value={client.code}
                      onChange={(event) => updateClient(index, "code", event.target.value.toUpperCase())}
                      placeholder="ABC"
                      maxLength="12"
                    />
                    <input
                      className="tag-color"
                      type="color"
                      aria-label="Client color tag"
                      value={client.tag}
                      onChange={(event) => updateClient(index, "tag", event.target.value)}
                    />
                    <button type="button" aria-label={`Remove ${client.name || "client"}`} onClick={() => removeClient(index)}>×</button>
                  </div>
                ))}
                {!settings.clients?.length && <p className="empty-clients">No clients yet. Add one to create projects.</p>}
              </div>
            </section>

            {settingsError && <p className="settings-error" role="alert">{settingsError}</p>}

            <div className="settings-actions">
              <button type="button" onClick={() => setSettingsOpen(false)}>Cancel</button>
              <button className="save-settings" type="submit" disabled={settingsBusy}>
                {settingsBusy ? "Testing connection…" : "Save and browse NAS"}
              </button>
            </div>
          </form>
        </div>
      )}

      {folderBrowser && (
        <div className="folder-browser-backdrop" role="presentation" onMouseDown={() => setFolderBrowser(null)}>
          <section
            className="folder-browser-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="folder-browser-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="export-heading">
              <div>
                <p className="eyebrow">Server folders</p>
                <h2 id="folder-browser-title">Choose NAS folder</h2>
              </div>
              <button type="button" aria-label="Close" onClick={() => setFolderBrowser(null)}>×</button>
            </div>

            <div className="folder-path" title={folderBrowser.path}>{folderBrowser.path || "Finding mounted folders…"}</div>

            <div className="folder-list" aria-busy={folderBrowserBusy}>
              {folderBrowser.parent && (
                <button type="button" className="folder-item parent" onClick={() => browseFolder(folderBrowser.parent)}>
                  <span>↰</span><span>Parent folder</span>
                </button>
              )}
              {folderBrowser.directories.map((directory) => (
                <button type="button" className="folder-item" key={directory.path} onClick={() => browseFolder(directory.path)}>
                  <span>📁</span><span>{directory.name}</span><span>›</span>
                </button>
              ))}
              {folderBrowserBusy && <p className="folder-message">Loading folders…</p>}
              {!folderBrowserBusy && !folderBrowserError && !folderBrowser.directories.length && (
                <p className="folder-message">No subfolders here. You can select this folder.</p>
              )}
              {folderBrowserError && <p className="settings-error" role="alert">{folderBrowserError}</p>}
            </div>

            <div className="settings-actions">
              <button type="button" onClick={() => setFolderBrowser(null)}>Cancel</button>
              <button
                className="save-settings"
                type="button"
                disabled={folderBrowserBusy || !folderBrowser.path}
                onClick={selectBrowsedFolder}
              >
                Select this folder
              </button>
            </div>
          </section>
        </div>
      )}

      {projectDialogOpen && (
        <div className="export-backdrop" role="presentation" onMouseDown={() => setProjectDialogOpen(false)}>
          <form
            className="settings-dialog project-dialog"
            aria-labelledby="project-title"
            onSubmit={createProject}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="export-heading">
              <div>
                <p className="eyebrow">NAS project template</p>
                <h2 id="project-title">Create Project Folders</h2>
              </div>
              <button type="button" aria-label="Close" onClick={() => setProjectDialogOpen(false)}>×</button>
            </div>

            <p className="settings-intro">
              Creates the complete production structure inside <strong>00 Project Archive</strong> on the connected NAS.
            </p>

            <div className="project-fields">
              <label className="settings-field">
                <span>Event date</span>
                <input
                  required
                  type="date"
                  value={project.date}
                  onChange={(event) => setProject({ ...project, date: event.target.value })}
                />
              </label>
              <label className="settings-field">
                <span>Event name</span>
                <input
                  required
                  autoFocus
                  value={project.eventName}
                  onChange={(event) => setProject({ ...project, eventName: event.target.value })}
                  placeholder="Annual Awards Night"
                />
              </label>
            </div>

            <label className="settings-field project-client">
              <span>Client</span>
              <select
                required
                value={project.clientCode}
                onChange={(event) => setProject({ ...project, clientCode: event.target.value })}
              >
                <option value="">Select a client</option>
                {settings.clients?.map((client) => (
                  <option value={client.code} key={client.code}>{client.name} — {client.code}</option>
                ))}
              </select>
            </label>

            <div className="project-preview">
              <span>Project location</span>
              <code>{(() => {
                const [year = "yyyy", month = "mm", day = "dd"] = project.date.split("-");
                return `00 Project Archive/${year}/${year}.${month}.${day} - ${project.clientCode || "CODE"} ${project.eventName || "Event Name"}`;
              })()}</code>
            </div>

            {projectError && <p className="settings-error" role="alert">{projectError}</p>}
            {projectCreated && (
              <p className="project-success" role="status">✓ Project folders created at {projectCreated}</p>
            )}

            <div className="settings-actions">
              <button type="button" onClick={() => setProjectDialogOpen(false)}>
                {projectCreated ? "Done" : "Cancel"}
              </button>
              <button className="save-settings" type="submit" disabled={projectBusy}>
                {projectBusy ? "Creating folders…" : projectCreated ? "Create another" : "Create folders"}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
