import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

try {
  loadEnvFile(path.resolve(".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const configDirectory = path.resolve("data");
const configFile = path.join(configDirectory, "nas-settings.json");
const itemLimit = 5000;
const googleOAuthStates = new Map();

const defaultSettings = {
  path: "",
  displayName: "NAS",
  includeHidden: false,
  maxDepth: 12,
  readonly: false,
  activeMount: "google",
  clients: [],
  projects: [],
  labels: [],
  muxAssets: [],
  googleDrive: {
    enabled: false,
    clientId: "",
    clientSecret: "",
    refreshToken: "",
    folderId: "",
    folderName: "",
    apiBaseUrl: "https://www.googleapis.com/drive/v3",
    tokenUrl: "https://oauth2.googleapis.com/token",
    redirectUri: "http://localhost:5174",
    direction: "drive-to-nas",
    autoSync: false,
    intervalMinutes: 30,
  },
};

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error("Request is too large");
  }
  return body ? JSON.parse(body) : {};
}

export async function getSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(configFile, "utf8"));
    return {
      ...defaultSettings,
      ...saved,
      googleDrive: { ...defaultSettings.googleDrive, ...(saved.googleDrive || {}) },
    };
  } catch (error) {
    if (error.code === "ENOENT") return defaultSettings;
    throw error;
  }
}

function publicSettings(settings) {
  const googleDrive = settings.googleDrive || defaultSettings.googleDrive;
  return {
    ...settings,
    googleDrive: {
      ...googleDrive,
      clientSecret: "",
      refreshToken: "",
      hasClientSecret: Boolean(googleDrive.clientSecret),
      hasRefreshToken: Boolean(googleDrive.refreshToken),
    },
  };
}

async function validateSettings(input) {
  const nasPath = String(input.path || "").trim();
  if (!nasPath || !path.isAbsolute(nasPath)) {
    throw new Error("Enter an absolute NAS path, such as /Volumes/NAS");
  }

  const resolvedPath = await fs.realpath(nasPath);
  const stats = await fs.stat(resolvedPath);
  if (!stats.isDirectory()) throw new Error("The NAS path must point to a folder");

  const clients = Array.isArray(input.clients) ? input.clients.map((client) => ({
    name: cleanFolderName(client.name, "Client name"),
    code: cleanFolderName(client.code, "Client code").toUpperCase(),
    tag: /^#[0-9a-f]{6}$/i.test(client.tag) ? client.tag.toUpperCase() : "#64748B",
  })) : [];
  const codes = new Set();
  for (const client of clients) {
    if (codes.has(client.code)) throw new Error(`Client code ${client.code} is duplicated`);
    codes.add(client.code);
  }

  const googleInput = input.googleDrive || {};
  const googleDrive = {
    enabled: Boolean(googleInput.enabled),
    clientId: String(googleInput.clientId || "").trim(),
    clientSecret: String(googleInput.clientSecret || "").trim(),
    refreshToken: String(googleInput.refreshToken || "").trim(),
    folderId: String(googleInput.folderId || "").trim(),
    folderName: String(googleInput.folderName || "").trim(),
    apiBaseUrl: String(googleInput.apiBaseUrl || defaultSettings.googleDrive.apiBaseUrl).replace(/\/$/, ""),
    tokenUrl: String(googleInput.tokenUrl || defaultSettings.googleDrive.tokenUrl),
    redirectUri: String(googleInput.redirectUri || defaultSettings.googleDrive.redirectUri).replace(/\/$/, ""),
    direction: ["drive-to-nas", "nas-to-drive", "two-way"].includes(googleInput.direction)
      ? googleInput.direction
      : "drive-to-nas",
    autoSync: Boolean(googleInput.autoSync),
    intervalMinutes: Math.min(1440, Math.max(5, Number(googleInput.intervalMinutes) || 30)),
  };
  if (googleDrive.enabled && (!googleDrive.clientId || !googleDrive.clientSecret || !googleDrive.refreshToken)) {
    throw new Error("Google Drive sync requires Client ID, Client Secret, and Refresh Token");
  }

  return {
    path: resolvedPath,
    displayName: String(input.displayName || path.basename(resolvedPath) || "NAS").trim(),
    includeHidden: Boolean(input.includeHidden),
    maxDepth: Math.min(30, Math.max(1, Number(input.maxDepth) || 12)),
    readonly: Boolean(input.readonly),
    activeMount: input.activeMount === "google" && googleDrive.folderId ? "google" : "nas",
    clients,
    projects: Array.isArray(input.projects) ? input.projects : [],
    labels: Array.isArray(input.labels) ? input.labels : [],
    muxAssets: Array.isArray(input.muxAssets) ? input.muxAssets : [],
    googleDrive,
  };
}

async function googleDriveAccess(settingsInput) {
  const saved = await getSettings();
  const google = {
    ...(saved.googleDrive || {}),
    ...(settingsInput.googleDrive || {}),
    clientSecret: settingsInput.googleDrive?.clientSecret || saved.googleDrive?.clientSecret || "",
    refreshToken: settingsInput.googleDrive?.refreshToken || saved.googleDrive?.refreshToken || "",
  };
  if (!google.clientId || !google.clientSecret || !google.refreshToken) {
    throw new Error("Enter the Google OAuth Client ID, Client Secret, and Refresh Token first");
  }
  if (!google.clientId.endsWith(".apps.googleusercontent.com")) {
    throw new Error("The Google OAuth Client ID must end with .apps.googleusercontent.com");
  }
  if (!/^1\/\/?/.test(google.refreshToken)) {
    throw new Error("The Refresh Token is not a Google OAuth refresh token. Generate an offline-access token; do not enter an API key or authorization code.");
  }
  const tokenResponse = await fetch(google.tokenUrl || defaultSettings.googleDrive.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: google.clientId,
      client_secret: google.clientSecret,
      refresh_token: google.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.access_token) {
    const message = token.error === "invalid_client"
      ? "Google rejected the OAuth Client ID or Client Secret. Confirm both values belong to the same OAuth client."
      : token.error === "invalid_grant"
        ? "Google rejected the Refresh Token. Generate a new offline-access refresh token for this OAuth client."
        : token.error_description || token.error || "Google OAuth authentication failed";
    const error = new Error(message);
    error.status = 401;
    throw error;
  }
  return { google, accessToken: token.access_token };
}

async function testGoogleDrive(settingsInput) {
  const { google, accessToken } = await googleDriveAccess(settingsInput);
  const apiBase = String(google.apiBaseUrl || defaultSettings.googleDrive.apiBaseUrl).replace(/\/$/, "");
  const endpoint = google.folderId
    ? `${apiBase}/files/${encodeURIComponent(google.folderId)}?fields=id,name,mimeType,modifiedTime&supportsAllDrives=true`
    : `${apiBase}/about?fields=user,storageQuota`;
  const driveResponse = await fetch(endpoint, { headers: { Authorization: `Bearer ${accessToken}` } });
  const result = await driveResponse.json();
  if (!driveResponse.ok) {
    const message = driveResponse.status === 404 && google.folderId
      ? "Google Drive cannot access that Folder ID. Re-authorize full Drive access, then confirm the folder still exists and is shared with this Google account."
      : result.error?.message || "Google Drive API connection failed";
    throw new Error(message);
  }
  return {
    connected: true,
    target: google.folderId ? { id: result.id, name: result.name, mimeType: result.mimeType } : null,
    user: result.user?.displayName || result.user?.emailAddress || null,
  };
}

async function listGoogleDriveFolders(input) {
  const { google, accessToken } = await googleDriveAccess(input);
  const apiBase = String(google.apiBaseUrl || defaultSettings.googleDrive.apiBaseUrl).replace(/\/$/, "");
  const parentId = String(input.parentId || "root");
  let current = { id: "root", name: "My Drive", parentId: null };
  if (parentId !== "root") {
    const currentResponse = await fetch(
      `${apiBase}/files/${encodeURIComponent(parentId)}?fields=id,name,parents&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const currentData = await currentResponse.json();
    if (!currentResponse.ok) throw new Error(currentData.error?.message || "Unable to open this Google Drive folder");
    current = { id: currentData.id, name: currentData.name, parentId: currentData.parents?.[0] || "root" };
  }
  const query = new URLSearchParams({
    q: `'${parentId.replaceAll("'", "\\'")}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name,modifiedTime,driveId)",
    orderBy: "name",
    pageSize: "1000",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const response = await fetch(`${apiBase}/files?${query}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || "Unable to list Google Drive folders");
  return { current, folders: result.files || [] };
}

function safeDriveName(name) {
  return String(name || "Untitled").replaceAll("/", "-").replaceAll("\\", "-");
}

async function loadGoogleFilemanager(input) {
  const settings = await getSettings();
  const google = { ...settings.googleDrive, ...(input.googleDrive || {}) };
  const driveId = String(input.driveId || google.folderId || "root");
  const rootName = safeDriveName(google.folderName || "Google Drive");
  if (!input.parentPath) {
    return [{ id: `/${rootName}`, type: "folder", lazy: true, open: false, driveId, source: "google" }];
  }
  const { accessToken } = await googleDriveAccess({ googleDrive: google });
  const apiBase = String(google.apiBaseUrl || defaultSettings.googleDrive.apiBaseUrl).replace(/\/$/, "");
  const query = new URLSearchParams({
    q: `'${driveId.replaceAll("'", "\\'")}' in parents and trashed=false`,
    fields: "files(id,name,mimeType,size,modifiedTime,driveId)",
    orderBy: "folder,name",
    pageSize: "1000",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const response = await fetch(`${apiBase}/files?${query}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || "Unable to load Google Drive files");
  const usedNames = new Set();
  return (result.files || []).map((file) => {
    let name = safeDriveName(file.name);
    if (usedNames.has(name.toLowerCase())) name = `${name} (${file.id.slice(-6)})`;
    usedNames.add(name.toLowerCase());
    const folder = file.mimeType === "application/vnd.google-apps.folder";
    return {
      id: `${input.parentPath}/${name}`,
      type: folder ? "folder" : "file",
      lazy: folder,
      open: false,
      size: Number(file.size) || 0,
      date: file.modifiedTime,
      driveId: file.id,
      mimeType: file.mimeType,
      source: "google",
    };
  });
}

function requestOrigin(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || (request.socket?.encrypted ? "https" : "http");
  const host = request.headers.host;
  if (!host) throw new Error("Unable to determine the OAuth redirect origin");
  return `${protocol}://${host}`;
}

async function createGoogleAuthorization(request, input) {
  const saved = await getSettings();
  const provided = input.googleDrive || {};
  const google = {
    ...(saved.googleDrive || {}),
    ...provided,
    clientSecret: provided.clientSecret || saved.googleDrive?.clientSecret || "",
  };
  if (!google.clientId || !google.clientSecret) {
    throw new Error("Enter the Google OAuth Client ID and Client Secret first");
  }
  const redirectUri = String(google.redirectUri || requestOrigin(request)).replace(/\/$/, "");
  let redirectUrl;
  try {
    redirectUrl = new URL(redirectUri);
  } catch {
    throw new Error("Enter a valid Google OAuth redirect URI");
  }
  if (!['http:', 'https:'].includes(redirectUrl.protocol) || redirectUrl.search || redirectUrl.hash) {
    throw new Error("The Google OAuth redirect URI must be an HTTP(S) origin without a query or fragment");
  }
  const state = randomBytes(32).toString("hex");
  googleOAuthStates.set(state, {
    createdAt: Date.now(),
    redirectUri,
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    tokenUrl: google.tokenUrl || defaultSettings.googleDrive.tokenUrl,
    google,
  });
  for (const [key, value] of googleOAuthStates) {
    if (Date.now() - value.createdAt > 10 * 60 * 1000) googleOAuthStates.delete(key);
  }
  const query = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: "https://www.googleapis.com/auth/drive",
    state,
  });
  return { authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query}`, redirectUri };
}

async function completeGoogleAuthorization(input) {
  const pending = googleOAuthStates.get(String(input.state || ""));
  googleOAuthStates.delete(String(input.state || ""));
  if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000) {
    throw new Error("Google authorization expired. Start authorization again.");
  }
  if (!input.code) throw new Error("Google did not return an authorization code");
  const tokenResponse = await fetch(pending.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: pending.clientId,
      client_secret: pending.clientSecret,
      redirect_uri: pending.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok) {
    const error = new Error(token.error_description || token.error || "Unable to exchange the Google authorization code");
    error.status = 401;
    throw error;
  }
  if (!token.refresh_token) {
    throw new Error("Google did not return a refresh token. Revoke the app's access, then authorize again with consent.");
  }
  const saved = await getSettings();
  const settings = await saveSettings({
    ...saved,
    googleDrive: {
      ...saved.googleDrive,
      ...pending.google,
      enabled: true,
      refreshToken: token.refresh_token,
    },
  });
  return { connected: true, settings: publicSettings(settings) };
}

export async function saveSettings(input) {
  const current = await getSettings();
  const settings = await validateSettings({
    ...input,
    googleDrive: {
      ...(input.googleDrive || {}),
      clientSecret: input.googleDrive?.clientSecret || current.googleDrive?.clientSecret || "",
      refreshToken: input.googleDrive?.refreshToken || current.googleDrive?.refreshToken || "",
    },
  });
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.writeFile(configFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return settings;
}

export async function scanNas(settings) {
  const valid = await validateSettings(settings || await getSettings());
  const rootName = valid.displayName.replaceAll("/", "-") || "NAS";
  const files = [{ id: `/${rootName}`, type: "folder", date: new Date() }];

  const projectTags = new Map(valid.projects.map((project) => [project.path, project]));
  const itemLabels = new Map(valid.labels.map((label) => [label.path, label]));

  async function walk(absoluteFolder, relativeFolder, depth) {
    if (depth >= valid.maxDepth || files.length >= itemLimit) return;

    const entries = await fs.readdir(absoluteFolder, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    for (const entry of entries) {
      if (files.length >= itemLimit) break;
      if (!valid.includeHidden && entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) continue;

      const absoluteItem = path.join(absoluteFolder, entry.name);
      const relativeItem = path.posix.join(relativeFolder, entry.name);
      const id = `/${rootName}/${relativeItem}`;

      try {
        const stats = await fs.stat(absoluteItem);
        if (entry.isDirectory()) {
          const project = projectTags.get(absoluteItem);
          const label = itemLabels.get(absoluteItem);
          files.push({
            id,
            type: "folder",
            date: stats.mtime,
            open: false,
            ...(project ? { tag: project.tag, clientCode: project.code, clientName: project.clientName } : {}),
            ...(label ? { label: label.name, labelColor: label.color } : {}),
          });
          await walk(absoluteItem, relativeItem, depth + 1);
        } else if (entry.isFile()) {
          const label = itemLabels.get(absoluteItem);
          files.push({
            id,
            type: "file",
            size: stats.size,
            date: stats.mtime,
            ...(label ? { label: label.name, labelColor: label.color } : {}),
          });
        }
      } catch (error) {
        if (!["EACCES", "EPERM", "ENOENT"].includes(error.code)) throw error;
      }
    }
  }

  await walk(valid.path, "", 0);
  return { files, truncated: files.length >= itemLimit, settings: publicSettings(valid) };
}

async function getDriveInfo(settings) {
  const stats = await fs.statfs(settings.path);
  const total = Number(stats.bsize) * Number(stats.blocks);
  const available = Number(stats.bsize) * Number(stats.bavail);
  return { used: Math.max(0, total - available), total };
}

function formatByteSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

async function getItemInfo(id) {
  const settings = await validateSettings(await getSettings());
  const itemPath = idToNasPath(id, settings);
  const stats = await fs.stat(itemPath);
  const project = settings.projects.find((entry) => entry.path === itemPath);
  const label = settings.labels.find((entry) => entry.path === itemPath);
  const relativePath = path.relative(settings.path, itemPath).split(path.sep).join("/") || "/";
  let count = 0;
  let totalSize = stats.isFile() ? stats.size : 0;
  let truncated = false;

  if (stats.isDirectory()) {
    const pending = [itemPath];
    while (pending.length && count < itemLimit) {
      const folder = pending.pop();
      const entries = await fs.readdir(folder, { withFileTypes: true });
      for (const entry of entries) {
        if (!settings.includeHidden && entry.name.startsWith(".")) continue;
        if (entry.isSymbolicLink()) continue;
        const child = path.join(folder, entry.name);
        try {
          const childStats = await fs.stat(child);
          count += 1;
          if (childStats.isDirectory()) pending.push(child);
          else if (childStats.isFile()) totalSize += childStats.size;
          if (count >= itemLimit) {
            truncated = true;
            break;
          }
        } catch (error) {
          if (!["EACCES", "EPERM", "ENOENT"].includes(error.code)) throw error;
        }
      }
    }
  }

  return {
    Size: formatByteSize(totalSize),
    Count: stats.isDirectory() ? `${count}${truncated ? "+" : ""} items` : "1 file",
    "NAS Path": `/${relativePath}`,
    ...(project ? { Client: `${project.clientName} (${project.code})`, "Client Tag": project.tag } : {}),
    ...(label ? { Label: label.name, "Label Color": label.color } : {}),
  };
}

async function listFolder(settings, folderId) {
  const rootName = settings.displayName.replaceAll("/", "-") || "NAS";
  const absoluteFolder = folderId ? idToNasPath(folderId, settings) : settings.path;
  const entries = await fs.readdir(absoluteFolder, { withFileTypes: true });
  const projectTags = new Map(settings.projects.map((project) => [project.path, project]));
  const itemLabels = new Map(settings.labels.map((label) => [label.path, label]));
  const files = [];

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const entry of entries) {
    if (!settings.includeHidden && entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) continue;
    const absoluteItem = path.join(absoluteFolder, entry.name);
    try {
      const stats = await fs.stat(absoluteItem);
      const relativeItem = path.relative(settings.path, absoluteItem).split(path.sep).join("/");
      const id = `/${rootName}/${relativeItem}`;
      if (entry.isDirectory()) {
        const project = projectTags.get(absoluteItem);
        const label = itemLabels.get(absoluteItem);
        files.push({
          id,
          type: "folder",
          date: stats.mtime,
          lazy: true,
          open: false,
          ...(project ? { tag: project.tag, clientCode: project.code, clientName: project.clientName } : {}),
          ...(label ? { label: label.name, labelColor: label.color } : {}),
        });
      } else if (entry.isFile()) {
        const label = itemLabels.get(absoluteItem);
        files.push({
          id,
          type: "file",
          size: stats.size,
          date: stats.mtime,
          ...(label ? { label: label.name, labelColor: label.color } : {}),
        });
      }
    } catch (error) {
      if (!["EACCES", "EPERM", "ENOENT"].includes(error.code)) throw error;
    }
  }
  return files;
}

export async function loadNasData(folderId = "") {
  const settings = await validateSettings(await getSettings());
  const files = await listFolder(settings, folderId);
  if (!folderId) {
    const rootName = settings.displayName.replaceAll("/", "-") || "NAS";
    const rootStats = await fs.stat(settings.path);
    files.unshift({ id: `/${rootName}`, type: "folder", date: rootStats.mtime, open: false });
  }
  return { files, drive: await getDriveInfo(settings), settings };
}

async function getBrowseStart() {
  for (const candidate of ["/Volumes", "/mnt", "/media"]) {
    try {
      if ((await fs.stat(candidate)).isDirectory()) return candidate;
    } catch {
      // Try the next conventional mount location.
    }
  }
  return path.parse(process.cwd()).root;
}

export async function browseDirectories(requestedPath) {
  const target = requestedPath
    ? await fs.realpath(requestedPath)
    : await getBrowseStart();
  const stats = await fs.stat(target);
  if (!stats.isDirectory()) throw new Error("The selected location is not a folder");

  const entries = await fs.readdir(target, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: path.join(target, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const root = path.parse(target).root;

  return {
    path: target,
    parent: target === root ? null : path.dirname(target),
    directories,
  };
}

const projectFolders = [
  "00 Documents/AVP Scripts",
  "00 Documents/Program Scripts",
  "01 AVP and Shooting/Final Hi-Res AVP Files",
  "01 AVP and Shooting/Relevant Music VO and Voice Over [Truncated]",
  "01 AVP and Shooting/Selected Raw Shoot Footage",
  "01 AVP and Shooting/Shared Assets/Logos",
  "01 AVP and Shooting/Shared Assets/Music Library",
  "01 AVP and Shooting/Shared Assets/Voice Overs",
  "02 Photo Coverage",
  "03 Video Photo Coverage and .../Final SDE and Highlights",
  "03 Video Photo Coverage and .../Raw Coverage",
  "04 Presentations/Approved Pitch Deck (PDF)",
  "04 Presentations/Event Decks (Full Resolution)",
];

function cleanFolderName(value, label) {
  const name = String(value || "").trim();
  if (!name) throw new Error(`${label} is required`);
  if (name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error(`${label} cannot contain slashes or reserved path names`);
  }
  return name;
}

function escapeDriveQuery(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

async function ensureGoogleFolder(apiBase, accessToken, parentId, name) {
  const query = new URLSearchParams({
    q: `'${escapeDriveQuery(parentId)}' in parents and name='${escapeDriveQuery(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
    pageSize: "1",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const lookup = await fetch(`${apiBase}/files?${query}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const found = await lookup.json();
  if (!lookup.ok) throw new Error(found.error?.message || `Unable to find Google Drive folder ${name}`);
  if (found.files?.[0]) return found.files[0];
  const created = await fetch(`${apiBase}/files?supportsAllDrives=true&fields=id,name`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  const folder = await created.json();
  if (!created.ok) throw new Error(folder.error?.message || `Unable to create Google Drive folder ${name}`);
  return folder;
}

async function createGoogleProjectFolders(settings, folderName, year, folders) {
  if (!settings.googleDrive.folderId) throw new Error("Choose a mounted Google Drive folder first");
  const { google, accessToken } = await googleDriveAccess({ googleDrive: settings.googleDrive });
  const apiBase = String(google.apiBaseUrl || defaultSettings.googleDrive.apiBaseUrl).replace(/\/$/, "");
  const archive = await ensureGoogleFolder(apiBase, accessToken, google.folderId, "00 Project Archive");
  const yearFolder = await ensureGoogleFolder(apiBase, accessToken, archive.id, year);
  const project = await ensureGoogleFolder(apiBase, accessToken, yearFolder.id, folderName);
  const cache = new Map([["", project.id]]);
  for (const relativeFolder of folders) {
    const parts = relativeFolder.split("/");
    let relative = "";
    let parentId = project.id;
    for (const part of parts) {
      relative = relative ? `${relative}/${part}` : part;
      if (!cache.has(relative)) {
        const created = await ensureGoogleFolder(apiBase, accessToken, parentId, part);
        cache.set(relative, created.id);
      }
      parentId = cache.get(relative);
    }
  }
  return {
    files: await loadGoogleFilemanager({ googleDrive: settings.googleDrive }),
    settings: publicSettings(settings),
    createdPath: `${google.folderName || "Google Drive"}/00 Project Archive/${year}/${folderName}`,
    createdCount: folders.length,
    mount: "google",
  };
}

export async function createProjectFolders(input) {
  const settings = await validateSettings(await getSettings());
  if (settings.readonly) throw new Error("NAS is in read-only mode");
  const date = String(input.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("A valid event date is required");
  const [year, month, day] = date.split("-");
  const eventName = cleanFolderName(input.eventName, "Event name");
  const clientCode = cleanFolderName(input.clientCode, "Client code").toUpperCase();
  const client = settings.clients.find((item) => item.code === clientCode);
  if (!client) throw new Error("Select a client configured in Admin Settings");
  const folderName = `${year}.${month}.${day} - ${client.code} ${eventName}`;
  const projectRoot = path.join(settings.path, "00 Project Archive", year, folderName);
  const folders = [
    ...projectFolders,
    `02 Photo Coverage/${client.name} - ${eventName}`,
  ];

  if (settings.activeMount === "google") {
    return await createGoogleProjectFolders(settings, folderName, year, folders);
  }

  await Promise.all(folders.map((folder) => fs.mkdir(path.join(projectRoot, folder), { recursive: true })));
  const projects = [
    ...settings.projects.filter((project) => project.path !== projectRoot),
    { path: projectRoot, clientName: client.name, code: client.code, tag: client.tag },
  ];
  const updatedSettings = { ...settings, projects };
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.writeFile(configFile, `${JSON.stringify(updatedSettings, null, 2)}\n`, "utf8");
  const scanned = await scanNas(updatedSettings);
  return {
    ...scanned,
    createdPath: projectRoot,
    createdCount: folders.length,
  };
}

function idToNasPath(id, settings) {
  const rootName = settings.displayName.replaceAll("/", "-") || "NAS";
  const prefix = `/${rootName}`;
  if (typeof id !== "string" || (id !== prefix && !id.startsWith(`${prefix}/`))) {
    throw new Error(`Invalid File Manager ID: ${id}`);
  }
  const relative = id.slice(prefix.length).replace(/^\/+/, "");
  const resolved = path.resolve(settings.path, relative);
  if (resolved !== settings.path && !resolved.startsWith(`${settings.path}${path.sep}`)) {
    throw new Error("File Manager ID resolves outside the NAS root");
  }
  return resolved;
}

async function ensureAvailable(target) {
  try {
    await fs.lstat(target);
    throw new Error(`An item already exists at ${target}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function replacePathPrefix(value, source, target) {
  if (value === source) return target;
  return value.startsWith(`${source}${path.sep}`) ? `${target}${value.slice(source.length)}` : value;
}

export async function performFileAction(input) {
  const settings = await validateSettings(await getSettings());
  if (settings.readonly) throw new Error("NAS is in read-only mode");
  const action = input.action;
  let projects = [...settings.projects];
  let labels = [...settings.labels];
  let muxAssets = [...settings.muxAssets];

  if (action === "create-file") {
    const target = idToNasPath(input.newId, settings);
    await ensureAvailable(target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (input.file?.type === "folder") await fs.mkdir(target);
    else await fs.writeFile(target, "");
    return { newId: input.newId };
  }

  if (action === "rename-file") {
    const source = idToNasPath(input.id, settings);
    const target = idToNasPath(input.newId, settings);
    await ensureAvailable(target);
    await fs.rename(source, target);
    projects = projects.map((project) => ({
      ...project,
      path: replacePathPrefix(project.path, source, target),
    }));
    labels = labels.map((label) => ({ ...label, path: replacePathPrefix(label.path, source, target) }));
    muxAssets = muxAssets.map((asset) => ({ ...asset, path: replacePathPrefix(asset.path, source, target) }));
  } else if (action === "move-files" || action === "copy-files") {
    if (!Array.isArray(input.ids) || input.ids.length !== input.newIds?.length) {
      throw new Error("The source and generated ID lists do not match");
    }
    for (let index = 0; index < input.ids.length; index += 1) {
      const source = idToNasPath(input.ids[index], settings);
      const target = idToNasPath(input.newIds[index], settings);
      await ensureAvailable(target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (action === "move-files") {
        await fs.rename(source, target);
        projects = projects.map((project) => ({
          ...project,
          path: replacePathPrefix(project.path, source, target),
        }));
        labels = labels.map((label) => ({ ...label, path: replacePathPrefix(label.path, source, target) }));
        muxAssets = muxAssets.map((asset) => ({ ...asset, path: replacePathPrefix(asset.path, source, target) }));
      } else {
        await fs.cp(source, target, { recursive: true, errorOnExist: true });
        const copiedProjects = projects
          .filter((project) => project.path === source || project.path.startsWith(`${source}${path.sep}`))
          .map((project) => ({ ...project, path: replacePathPrefix(project.path, source, target) }));
        projects.push(...copiedProjects);
        const copiedLabels = labels
          .filter((label) => label.path === source || label.path.startsWith(`${source}${path.sep}`))
          .map((label) => ({ ...label, path: replacePathPrefix(label.path, source, target) }));
        labels.push(...copiedLabels);
        const copiedMuxAssets = muxAssets
          .filter((asset) => asset.path === source || asset.path.startsWith(`${source}${path.sep}`))
          .map((asset) => ({ ...asset, path: replacePathPrefix(asset.path, source, target) }));
        muxAssets.push(...copiedMuxAssets);
      }
    }
  } else if (action === "delete-files") {
    if (!Array.isArray(input.ids)) throw new Error("No File Manager IDs were provided");
    const targets = input.ids.map((id) => idToNasPath(id, settings));
    for (const target of targets) await fs.rm(target, { recursive: true, force: false });
    projects = projects.filter((project) => !targets.some(
      (target) => project.path === target || project.path.startsWith(`${target}${path.sep}`),
    ));
    labels = labels.filter((label) => !targets.some(
      (target) => label.path === target || label.path.startsWith(`${target}${path.sep}`),
    ));
    muxAssets = muxAssets.filter((asset) => !targets.some(
      (target) => asset.path === target || asset.path.startsWith(`${target}${path.sep}`),
    ));
  } else {
    throw new Error(`Unsupported file action: ${action}`);
  }

  if (JSON.stringify(projects) !== JSON.stringify(settings.projects)
    || JSON.stringify(labels) !== JSON.stringify(settings.labels)
    || JSON.stringify(muxAssets) !== JSON.stringify(settings.muxAssets)) {
    await fs.writeFile(configFile, `${JSON.stringify({ ...settings, projects, labels, muxAssets }, null, 2)}\n`, "utf8");
  }
  return { newId: input.newId, newIds: input.newIds };
}

async function applyLabels(input) {
  const settings = await validateSettings(await getSettings());
  if (settings.readonly) throw new Error("NAS is in read-only mode");
  if (!Array.isArray(input.ids) || !input.ids.length) throw new Error("Select at least one item");
  const name = cleanFolderName(input.name, "Label name");
  const color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color.toUpperCase() : "#64748B";
  const selectedPaths = input.ids.map((id) => idToNasPath(id, settings));
  const labels = [
    ...settings.labels.filter((label) => !selectedPaths.includes(label.path)),
    ...selectedPaths.map((itemPath) => ({ path: itemPath, name, color })),
  ];
  await fs.writeFile(configFile, `${JSON.stringify({ ...settings, labels }, null, 2)}\n`, "utf8");
  return { labels: selectedPaths.map((itemPath) => ({ path: itemPath, name, color })) };
}

const videoExtensions = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm"]);

function muxCredentials() {
  const tokenId = process.env.MUX_TOKEN_ID;
  const tokenSecret = process.env.MUX_TOKEN_SECRET;
  return tokenId && tokenSecret ? { tokenId, tokenSecret } : null;
}

async function muxRequest(endpoint, options = {}) {
  const credentials = muxCredentials();
  if (!credentials) throw new Error("Mux credentials are not configured on the server");
  const response = await fetch(`https://api.mux.com/video/v1${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.tokenId}:${credentials.tokenSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Mux API returned ${response.status}`);
  return result.data;
}

async function writeMuxRecord(record) {
  const settings = await getSettings();
  const muxAssets = [
    ...(settings.muxAssets || []).filter((item) => item.path !== record.path),
    record,
  ];
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.writeFile(configFile, `${JSON.stringify({ ...settings, muxAssets }, null, 2)}\n`, "utf8");
  return record;
}

async function startMuxUpload(id) {
  const settings = await validateSettings(await getSettings());
  if (settings.readonly) throw new Error("NAS is in read-only mode");
  if (!muxCredentials()) throw new Error("Set MUX_TOKEN_ID and MUX_TOKEN_SECRET on the server first");
  const filePath = idToNasPath(id, settings);
  const stats = await fs.stat(filePath);
  if (!stats.isFile() || !videoExtensions.has(path.extname(filePath).toLowerCase())) {
    throw new Error("Select a supported video file");
  }

  const existing = settings.muxAssets.find((item) => item.path === filePath);
  if (existing && !["error", "timed_out", "cancelled"].includes(existing.status)) return existing;

  const upload = await muxRequest("/uploads", {
    method: "POST",
    body: JSON.stringify({
      cors_origin: "*",
      timeout: 86400,
      new_asset_settings: {
        passthrough: id,
        playback_policies: ["public"],
        video_quality: "basic",
      },
    }),
  });
  const record = await writeMuxRecord({
    path: filePath,
    fileId: id,
    uploadId: upload.id,
    assetId: null,
    playbackId: null,
    status: "uploading",
    error: null,
    createdAt: new Date().toISOString(),
  });

  const uploader = spawn("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--request", "PUT",
    "--upload-file", filePath,
    upload.url,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let uploadError = "";
  uploader.stderr.on("data", (chunk) => { uploadError += chunk.toString(); });
  uploader.on("error", (error) => { uploadError = error.message; });
  uploader.on("close", async (code) => {
    try {
      const current = (await getSettings()).muxAssets?.find((item) => item.path === filePath) || record;
      await writeMuxRecord({
        ...current,
        status: code === 0 ? "processing" : "error",
        error: code === 0 ? null : uploadError.trim() || `Upload exited with code ${code}`,
      });
    } catch (error) {
      console.error("Unable to persist Mux upload result", error);
    }
  });

  return record;
}

async function getMuxStatus(id) {
  const settings = await validateSettings(await getSettings());
  const filePath = idToNasPath(id, settings);
  let record = settings.muxAssets.find((item) => item.path === filePath);
  if (!record) return { configured: Boolean(muxCredentials()), status: "not_uploaded", fileId: id };
  if (!muxCredentials()) return { configured: false, ...record };

  try {
    if (!record.assetId && record.uploadId) {
      const upload = await muxRequest(`/uploads/${encodeURIComponent(record.uploadId)}`);
      record = {
        ...record,
        status: upload.status === "asset_created" ? "processing" : upload.status,
        assetId: upload.asset_id || record.assetId,
        error: upload.error?.message || record.error,
      };
    }
    if (record.assetId) {
      const asset = await muxRequest(`/assets/${encodeURIComponent(record.assetId)}`);
      record = {
        ...record,
        status: asset.status,
        playbackId: asset.playback_ids?.[0]?.id || record.playbackId,
        error: asset.errors?.messages?.join(" ") || record.error,
        duration: asset.duration,
        aspectRatio: asset.aspect_ratio,
      };
    }
    await writeMuxRecord(record);
  } catch (error) {
    record = { ...record, error: error.message };
  }
  return { configured: true, ...record };
}

async function uploadFile(request, id) {
  const settings = await validateSettings(await getSettings());
  if (settings.readonly) throw new Error("NAS is in read-only mode");
  const target = idToNasPath(id, settings);
  await ensureAvailable(target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await pipeline(request, createWriteStream(target, { flags: "wx" }));
  return { newId: id };
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

async function serveDirectFile(request, response, id, download) {
  const settings = await validateSettings(await getSettings());
  const filePath = idToNasPath(id, settings);
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error("Only files can be opened or downloaded");

  const filename = path.basename(filePath);
  const encodedName = encodeURIComponent(filename).replaceAll("'", "%27");
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodedName}`,
    "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Last-Modified": stats.mtime.toUTCString(),
    "X-Content-Type-Options": "nosniff",
  };
  if ([".html", ".htm", ".svg"].includes(path.extname(filePath).toLowerCase())) {
    headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  }

  let start = 0;
  let end = stats.size - 1;
  let status = 200;
  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    start = range[1] ? Number(range[1]) : 0;
    end = range[2] ? Math.min(Number(range[2]), end) : end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stats.size) {
      response.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
      response.end();
      return;
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${stats.size}`;
  }
  headers["Content-Length"] = String(Math.max(0, end - start + 1));
  response.writeHead(status, headers);
  if (request.method === "HEAD" || stats.size === 0) return response.end();
  createReadStream(filePath, { start, end }).pipe(response);
}

async function createUniqueId(parentId, name, settings, reserved = new Set()) {
  const dot = name.lastIndexOf(".");
  const extension = dot !== -1 ? name.slice(dot) : "";
  let base = dot !== -1 ? name.slice(0, dot) : name;
  let id = `${parentId === "/" ? "" : parentId}/${base}${extension}`;
  while (true) {
    if (reserved.has(id)) {
      base += ".new";
      id = `${parentId === "/" ? "" : parentId}/${base}${extension}`;
      continue;
    }
    try {
      await fs.lstat(idToNasPath(id, settings));
      base += ".new";
      id = `${parentId === "/" ? "" : parentId}/${base}${extension}`;
    } catch (error) {
      if (error.code === "ENOENT") return id;
      throw error;
    }
  }
}

async function handleRestApi(request, response, url) {
  const base = "/api/nas/rest";
  const settings = await validateSettings(await getSettings());
  const filePrefix = `${base}/files/`;

  if (request.method === "GET" && url.pathname === `${base}/files`) {
    return json(response, 200, (await loadNasData()).files);
  }
  if (request.method === "GET" && url.pathname.startsWith(filePrefix)) {
    const id = decodeURIComponent(url.pathname.slice(filePrefix.length));
    return json(response, 200, (await loadNasData(id)).files);
  }
  if (request.method === "GET" && url.pathname === `${base}/info`) {
    return json(response, 200, { stats: await getDriveInfo(settings) });
  }

  if (settings.readonly) throw new Error("NAS is in read-only mode");

  if (request.method === "POST" && url.pathname.startsWith(filePrefix)) {
    const parent = decodeURIComponent(url.pathname.slice(filePrefix.length));
    const body = await readBody(request);
    const newId = await createUniqueId(parent, cleanFolderName(body.name, "Item name"), settings);
    await performFileAction({ action: "create-file", newId, file: { type: body.type } });
    return json(response, 201, { result: { id: newId } });
  }
  if (request.method === "PUT" && url.pathname.startsWith(filePrefix)) {
    const id = decodeURIComponent(url.pathname.slice(filePrefix.length));
    const body = await readBody(request);
    if (body.operation !== "rename") throw new Error("Unsupported item operation");
    const parent = id.slice(0, id.lastIndexOf("/")) || "/";
    const newId = await createUniqueId(parent, cleanFolderName(body.name, "Item name"), settings);
    if (newId !== id) await performFileAction({ action: "rename-file", id, newId });
    return json(response, 200, { result: { id: newId } });
  }
  if (request.method === "PUT" && url.pathname === `${base}/files`) {
    const body = await readBody(request);
    if (!["move", "copy"].includes(body.operation)) throw new Error("Unsupported files operation");
    const newIds = [];
    const reserved = new Set();
    for (const id of body.ids || []) {
      const newId = await createUniqueId(body.target, id.split("/").pop(), settings, reserved);
      reserved.add(newId);
      newIds.push(newId);
    }
    await performFileAction({
      action: `${body.operation}-files`,
      ids: body.ids,
      target: body.target,
      newIds,
    });
    return json(response, 200, { result: newIds.map((id) => ({ id })) });
  }
  if (request.method === "DELETE" && url.pathname === `${base}/files`) {
    const body = await readBody(request);
    await performFileAction({ action: "delete-files", ids: body.ids });
    return json(response, 200, { result: body.ids });
  }
  if (request.method === "POST" && url.pathname === `${base}/upload`) {
    const parent = url.searchParams.get("id");
    const webRequest = new Request("http://localhost/upload", {
      method: "POST",
      headers: request.headers,
      body: Readable.toWeb(request),
      duplex: "half",
    });
    const form = await webRequest.formData();
    const file = form.get("file");
    const name = cleanFolderName(form.get("name") || file?.name, "File name");
    if (!file || typeof file.stream !== "function") throw new Error("Upload does not contain a file");
    const newId = await createUniqueId(parent, name, settings);
    const target = idToNasPath(newId, settings);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await pipeline(Readable.fromWeb(file.stream()), createWriteStream(target, { flags: "wx" }));
    return json(response, 201, { result: { id: newId } });
  }

  return json(response, 404, { error: "REST endpoint not found" });
}

export async function handleNasApi(request, response) {
  try {
    const url = new URL(request.url, "http://localhost");

    if (url.pathname.startsWith("/api/nas/rest")) {
      return await handleRestApi(request, response, url);
    }

    if (["GET", "HEAD"].includes(request.method) && url.pathname === "/api/nas/direct") {
      return await serveDirectFile(
        request,
        response,
        url.searchParams.get("id"),
        url.searchParams.get("download") === "true",
      );
    }

    if (request.method === "GET" && url.pathname === "/api/nas/item-info") {
      return json(response, 200, await getItemInfo(url.searchParams.get("id")));
    }

    if (request.method === "GET" && url.pathname === "/api/nas/settings") {
      return json(response, 200, publicSettings(await getSettings()));
    }

    if (request.method === "POST" && url.pathname === "/api/nas/settings") {
      const settings = await saveSettings(await readBody(request));
      return json(response, 200, await scanNas(settings));
    }

    if (request.method === "POST" && url.pathname === "/api/google-drive/test") {
      return json(response, 200, await testGoogleDrive(await readBody(request)));
    }

    if (request.method === "POST" && url.pathname === "/api/google-drive/auth-url") {
      return json(response, 200, await createGoogleAuthorization(request, await readBody(request)));
    }

    if (request.method === "POST" && url.pathname === "/api/google-drive/oauth-callback") {
      return json(response, 200, await completeGoogleAuthorization(await readBody(request)));
    }

    if (request.method === "POST" && url.pathname === "/api/google-drive/folders") {
      return json(response, 200, await listGoogleDriveFolders(await readBody(request)));
    }

    if (request.method === "POST" && url.pathname === "/api/google-drive/filemanager") {
      return json(response, 200, await loadGoogleFilemanager(await readBody(request)));
    }

    if (request.method === "GET" && url.pathname === "/api/nas/files") {
      const folderId = url.searchParams.get("id");
      return json(response, 200, folderId !== null ? await loadNasData(folderId) : await scanNas());
    }

    if (request.method === "GET" && url.pathname === "/api/nas/load") {
      return json(response, 200, await loadNasData(url.searchParams.get("id") || ""));
    }

    if (request.method === "GET" && url.pathname === "/api/nas/directories") {
      return json(response, 200, await browseDirectories(url.searchParams.get("path") || ""));
    }

    if (request.method === "POST" && url.pathname === "/api/nas/create-project") {
      return json(response, 201, await createProjectFolders(await readBody(request)));
    }

    if (request.method === "POST" && url.pathname === "/api/nas/action") {
      return json(response, 200, await performFileAction(await readBody(request)));
    }

    if (request.method === "POST" && url.pathname === "/api/nas/upload") {
      return json(response, 201, await uploadFile(request, url.searchParams.get("id")));
    }

    if (request.method === "POST" && url.pathname === "/api/nas/labels") {
      return json(response, 200, await applyLabels(await readBody(request)));
    }

    if (request.method === "POST" && url.pathname === "/api/mux/upload") {
      const body = await readBody(request);
      return json(response, 202, await startMuxUpload(body.id));
    }

    if (request.method === "GET" && url.pathname === "/api/mux/status") {
      return json(response, 200, await getMuxStatus(url.searchParams.get("id")));
    }

    return json(response, 404, { error: "Not found" });
  } catch (error) {
    const status = error.status || (["EACCES", "EPERM"].includes(error.code) ? 403 : 400);
    return json(response, status, { error: error.message || "Unable to access NAS path" });
  }
}
