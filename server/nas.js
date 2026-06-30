import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const configDirectory = path.resolve("data");
const configFile = path.join(configDirectory, "nas-settings.json");
const itemLimit = 5000;

const defaultSettings = {
  path: "",
  displayName: "NAS",
  includeHidden: false,
  maxDepth: 12,
  readonly: false,
  clients: [],
  projects: [],
  labels: [],
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
    return { ...defaultSettings, ...JSON.parse(await fs.readFile(configFile, "utf8")) };
  } catch (error) {
    if (error.code === "ENOENT") return defaultSettings;
    throw error;
  }
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

  return {
    path: resolvedPath,
    displayName: String(input.displayName || path.basename(resolvedPath) || "NAS").trim(),
    includeHidden: Boolean(input.includeHidden),
    maxDepth: Math.min(30, Math.max(1, Number(input.maxDepth) || 12)),
    readonly: Boolean(input.readonly),
    clients,
    projects: Array.isArray(input.projects) ? input.projects : [],
    labels: Array.isArray(input.labels) ? input.labels : [],
  };
}

export async function saveSettings(input) {
  const settings = await validateSettings(input);
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
  return { files, truncated: files.length >= itemLimit, settings: valid };
}

async function getDriveInfo(settings) {
  const stats = await fs.statfs(settings.path);
  const total = Number(stats.bsize) * Number(stats.blocks);
  const available = Number(stats.bsize) * Number(stats.bavail);
  return { used: Math.max(0, total - available), total };
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
    files.unshift({ id: `/${rootName}`, type: "folder", date: rootStats.mtime });
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
  } else {
    throw new Error(`Unsupported file action: ${action}`);
  }

  if (JSON.stringify(projects) !== JSON.stringify(settings.projects)
    || JSON.stringify(labels) !== JSON.stringify(settings.labels)) {
    await fs.writeFile(configFile, `${JSON.stringify({ ...settings, projects, labels }, null, 2)}\n`, "utf8");
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

    if (request.method === "GET" && url.pathname === "/api/nas/settings") {
      return json(response, 200, await getSettings());
    }

    if (request.method === "POST" && url.pathname === "/api/nas/settings") {
      const settings = await saveSettings(await readBody(request));
      return json(response, 200, await scanNas(settings));
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

    return json(response, 404, { error: "Not found" });
  } catch (error) {
    const status = ["EACCES", "EPERM"].includes(error.code) ? 403 : 400;
    return json(response, status, { error: error.message || "Unable to access NAS path" });
  }
}
