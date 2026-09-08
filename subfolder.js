const fs = require("fs");

const CLOAK_VIEW = "d7Fm2Kp9Qx4Nw8Rz";
const HTTP_TIMEOUT_MS = 10000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LOCALE_FOLDER_RE = /^[a-z]{2}(?:-[a-z]{2})?$/;
const ALL_INNER_SLOTS = ["login", "bonuses", "bonus", "register"];

function withCloakView(url) {
    try {
        const parsed = new URL(url);
        if (!parsed.searchParams.has("view")) {
            parsed.searchParams.set("view", CLOAK_VIEW);
        }
        return parsed.toString();
    } catch {
        return url;
    }
}

function normalizeHost(host) {
    return String(host || "")
        .toLowerCase()
        .replace(/\.$/, "")
        .replace(/^www\./, "");
}

function isLocaleFolder(seg) {
    return LOCALE_FOLDER_RE.test(String(seg || "").toLowerCase());
}

function normalizePathname(pathname) {
    let p = String(pathname || "/");
    if (!p.startsWith("/")) p = `/${p}`;
    if (p.length > 1) p = p.replace(/\/+$/, "");
    return p.toLowerCase() || "/";
}

function isForeignRedirect(fromUrl, location) {
    if (!location) return false;
    try {
        const dest = new URL(location, fromUrl);
        const src = new URL(fromUrl);
        if (dest.protocol !== "http:" && dest.protocol !== "https:") {
            return false;
        }
        return normalizeHost(src.hostname) !== normalizeHost(dest.hostname);
    } catch {
        return false;
    }
}

function isSamePathRedirect(fromUrl, location) {
    if (!location) return false;
    try {
        const dest = new URL(location, fromUrl);
        const src = new URL(fromUrl);
        if (normalizeHost(src.hostname) !== normalizeHost(dest.hostname)) {
            return false;
        }
        return normalizePathname(dest.pathname) === normalizePathname(src.pathname);
    } catch {
        return false;
    }
}

function locationFolder(fromUrl, location, expectedFolder) {
    if (!location) return null;
    try {
        const dest = new URL(location, fromUrl);
        const src = new URL(fromUrl);
        if (normalizeHost(src.hostname) !== normalizeHost(dest.hostname)) {
            return null;
        }
        const parts = dest.pathname.split("/").filter(Boolean);
        if (!parts.length) return null;
        const first = parts[0].toLowerCase();
        if (expectedFolder && first === expectedFolder.toLowerCase()) {
            return expectedFolder.toLowerCase();
        }
        if (isLocaleFolder(first)) return first;
        return null;
    } catch {
        return null;
    }
}

function splitCsvLine(line) {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"' && line[i + 1] === '"') {
                cur += '"';
                i += 1;
            } else if (c === '"') {
                inQuotes = false;
            } else {
                cur += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ",") {
            out.push(cur);
            cur = "";
        } else {
            cur += c;
        }
    }
    out.push(cur);
    return out;
}

function parseCsv(text) {
    const lines = String(text || "")
        .split(/\r?\n/)
        .filter((line) => line.length);
    if (!lines.length) return [];
    const headers = splitCsvLine(lines[0]).map((h) => h.trim());
    const rows = [];
    for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const cols = splitCsvLine(line);
        const row = {};
        for (let i = 0; i < headers.length; i += 1) {
            row[headers[i]] = cols[i] == null ? "" : cols[i];
        }
        rows.push(row);
    }
    return rows;
}

function parseSubfolderField(raw) {
    const csv = raw == null ? "" : String(raw).trim();
    if (!csv) {
        return { folder: null, csv: null, mode: null, page: null };
    }
    let body = csv;
    const rewrite = body.match(/:rewrite:(root|prev)$/i);
    if (rewrite) body = body.slice(0, rewrite.index);
    body = body.trim();
    const m = body.match(/^([^[\s]+)(?:\[([^\]]*)\])?$/);
    if (!m) {
        return { folder: null, csv, mode: null, page: null };
    }
    const folder = m[1].trim().toLowerCase() || null;
    const modeToken = (m[2] || "").trim().toLowerCase();
    let mode = "home";
    let page = null;
    if (modeToken === "all") {
        mode = "all";
    } else if (modeToken && modeToken !== "home") {
        mode = "page";
        page = modeToken;
    }
    return { folder, csv, mode, page };
}

function loadSubfolderByHost(csvText) {
    const map = new Map();
    for (const row of parseCsv(csvText)) {
        const domain = String(row.domain || "")
            .trim()
            .toLowerCase()
            .replace(/^www\./, "");
        if (!domain) continue;
        const parsed = parseSubfolderField(row.subfolder);
        const existing = map.get(domain);
        if (!existing) {
            map.set(domain, parsed);
            continue;
        }
        if (!existing.csv && parsed.csv) map.set(domain, parsed);
    }
    return map;
}

function loadSubfolderCatalog(csvPath = "./sites.csv") {
    try {
        if (!fs.existsSync(csvPath)) return new Map();
        return loadSubfolderByHost(fs.readFileSync(csvPath, "utf8"));
    } catch {
        return new Map();
    }
}

function parsedSubfolderForUrl(catalog, url) {
    const empty = parseSubfolderField(null);
    if (!catalog || !url) return empty;
    try {
        const host = normalizeHost(new URL(url).hostname);
        return catalog.get(host) || empty;
    } catch {
        return empty;
    }
}

function subfolderPayload({
    folder = null,
    csv = null,
    mode = null,
    match = null,
    glue = null,
    live_folder = null,
    error = null,
} = {}) {
    return {
        folder: folder || null,
        csv: csv || null,
        mode: mode || null,
        match: match === true ? true : match === false ? false : null,
        glue: glue === "canonical" || glue === "301" ? glue : null,
        live_folder: live_folder || null,
        error: error || null,
    };
}

function subfolderForUnreachable(parsed, error) {
    const p = parsed && typeof parsed === "object" ? parsed : parseSubfolderField(parsed);
    return subfolderPayload({
        folder: p.folder,
        csv: p.csv,
        mode: p.mode,
        match: null,
        glue: null,
        live_folder: null,
        error: error || null,
    });
}

function extractCanonicalHref(html) {
    if (!html) return null;
    const re = /<link\b[^>]*>/gi;
    let m;
    while ((m = re.exec(String(html)))) {
        const tag = m[0];
        if (!/\brel\s*=\s*(['"]?)\s*canonical\s*\1/i.test(tag) && !/\brel\s*=\s*canonical\b/i.test(tag)) {
            continue;
        }
        const quoted = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
        if (quoted) return quoted[1].trim();
        const unquoted = tag.match(/\bhref\s*=\s*([^\s>]+)/i);
        if (unquoted) return unquoted[1].trim().replace(/\/?>$/, "");
    }
    return null;
}

function liveFolderFromCanonical(siteUrl, href) {
    if (!href) return null;
    try {
        const dest = new URL(href, siteUrl);
        const src = new URL(siteUrl);
        if (normalizeHost(dest.hostname) !== normalizeHost(src.hostname)) {
            return null;
        }
        const parts = dest.pathname.split("/").filter(Boolean);
        if (parts.length !== 1) return null;
        const folder = parts[0].toLowerCase();
        return isLocaleFolder(folder) ? folder : null;
    } catch {
        return null;
    }
}

function hopFromResponse(url, response) {
    const location = response.headers?.get?.("location") || null;
    return {
        status: response.status,
        location,
        url,
        response,
        foreign: isForeignRedirect(url, location),
    };
}

async function probeUrl(url, fetchFn) {
    const requestUrl = withCloakView(url);
    const response = await fetchFn(requestUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const first = hopFromResponse(requestUrl, response);
    const samePath =
        REDIRECT_STATUSES.has(first.status) &&
        !first.foreign &&
        isSamePathRedirect(requestUrl, first.location);
    if (!samePath) {
        return { first, effective: first, cloakFollow: false };
    }
    const dest = new URL(first.location, requestUrl);
    dest.search = "";
    dest.hash = "";
    const destUrl = dest.toString();
    const response2 = await fetchFn(destUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const second = hopFromResponse(destUrl, response2);
    return { first, effective: second, cloakFollow: true };
}

function probeIsForeign(probe) {
    return Boolean(probe?.first?.foreign || probe?.effective?.foreign);
}

function find301Folder(probe, expectedFolder) {
    const hops = [probe.first];
    if (probe.cloakFollow) hops.push(probe.effective);
    for (const hop of hops) {
        if (hop.status !== 301 || !hop.location || hop.foreign) continue;
        if (isSamePathRedirect(hop.url, hop.location)) continue;
        const folder = locationFolder(hop.url, hop.location, expectedFolder);
        if (folder) return folder;
    }
    return null;
}

async function readHtml(hop) {
    if (!hop || hop.status !== 200 || !hop.response || typeof hop.response.text !== "function") {
        return null;
    }
    try {
        return await hop.response.text();
    } catch {
        return null;
    }
}

function folderUrl(origin, folder) {
    return new URL(`/${folder}/`, `${origin}/`).toString();
}

async function folderIs200(origin, folder, fetchFn) {
    const probe = await probeUrl(folderUrl(origin, folder), fetchFn);
    if (probeIsForeign(probe)) return false;
    return probe.effective.status === 200;
}

async function hasInner200(origin, folder, fetchFn) {
    for (const slot of ALL_INNER_SLOTS) {
        const url = new URL(`/${folder}/${slot}/`, `${origin}/`).toString();
        const probe = await probeUrl(url, fetchFn);
        if (probeIsForeign(probe)) continue;
        if (probe.effective.status === 200) return true;
    }
    return false;
}

function asParsed(input) {
    if (input && typeof input === "object" && "folder" in input && "csv" in input) {
        return input;
    }
    return parseSubfolderField(input);
}

async function checkSubfolder(siteUrl, parsedInput, { fetchFn = fetch } = {}) {
    const parsed = asParsed(parsedInput);
    const base = {
        folder: parsed.folder,
        csv: parsed.csv,
        mode: parsed.mode,
    };

    try {
        const origin = new URL(siteUrl).origin;
        const rootUrl = new URL("/", `${origin}/`).toString();
        const glueUrl =
            parsed.mode === "page" && parsed.page
                ? new URL(`/${parsed.page}/`, `${origin}/`).toString()
                : rootUrl;

        const glueProbe = await probeUrl(glueUrl, fetchFn);
        const rootProbe =
            glueUrl === rootUrl ? glueProbe : await probeUrl(rootUrl, fetchFn);

        if (probeIsForeign(rootProbe) || probeIsForeign(glueProbe)) {
            return subfolderPayload({ ...base, error: "foreign redirect" });
        }

        const live301 = find301Folder(glueProbe, parsed.folder);
        const html = await readHtml(rootProbe.effective);
        const canonHref = extractCanonicalHref(html);
        const liveCanon = liveFolderFromCanonical(siteUrl, canonHref);

        const toProbe = new Set();
        if (parsed.folder) toProbe.add(parsed.folder);
        if (live301) toProbe.add(live301);
        if (liveCanon) toProbe.add(liveCanon);

        const live200 = {};
        for (const folder of toProbe) {
            try {
                live200[folder] = await folderIs200(origin, folder, fetchFn);
            } catch (err) {
                live200[folder] = err;
            }
        }

        const csvLive = parsed.folder ? live200[parsed.folder] : undefined;
        if (csvLive instanceof Error) {
            const incomplete = html == null && !live301;
            if (incomplete) {
                return subfolderPayload({
                    ...base,
                    error: csvLive.message || "subfolder timeout",
                });
            }
        }

        let glue = null;
        if (live301) {
            glue = "301";
        } else if (liveCanon && live200[liveCanon] === true && html != null) {
            glue = "canonical";
        }

        const liveDetected = live301 || liveCanon || null;
        const live_folder =
            liveDetected && liveDetected !== parsed.folder ? liveDetected : null;

        let match = null;
        if (!parsed.folder) {
            match = liveDetected ? false : null;
        } else if (csvLive === true && (live301 === parsed.folder || liveCanon === parsed.folder)) {
            match = true;
        } else if (csvLive === false) {
            match = false;
        } else if (liveDetected && liveDetected !== parsed.folder) {
            match = false;
        } else if (csvLive instanceof Error) {
            match = null;
        } else if (html != null && liveCanon !== parsed.folder && live301 !== parsed.folder) {
            match = false;
        } else {
            match = null;
        }

        if (match === true && parsed.mode === "all") {
            try {
                const innerOk = await hasInner200(origin, parsed.folder, fetchFn);
                if (!innerOk) match = false;
            } catch (err) {
                return subfolderPayload({
                    ...base,
                    match: null,
                    glue,
                    live_folder,
                    error: err.message || "inner check failed",
                });
            }
        }

        return subfolderPayload({
            ...base,
            match,
            glue,
            live_folder,
            error:
                match == null && csvLive instanceof Error
                    ? csvLive.message || "subfolder timeout"
                    : null,
        });
    } catch (err) {
        return subfolderPayload({
            ...base,
            error: err.message || "subfolder check failed",
        });
    }
}

function logSubfolder(results) {
    let ok = 0;
    let bad = 0;
    let skip = 0;
    for (const row of results) {
        const m = row.subfolder?.match;
        if (m === true) ok += 1;
        else if (m === false) bad += 1;
        else skip += 1;
    }
    console.log(`Subfolder: ${ok} match, ${bad} mismatch, ${skip} skip`);
}

module.exports = {
    CLOAK_VIEW,
    HTTP_TIMEOUT_MS,
    REDIRECT_STATUSES,
    withCloakView,
    isForeignRedirect,
    isSamePathRedirect,
    hopFromResponse,
    parseSubfolderField,
    parseCsv,
    loadSubfolderByHost,
    loadSubfolderCatalog,
    parsedSubfolderForUrl,
    subfolderPayload,
    subfolderForUnreachable,
    checkSubfolder,
    extractCanonicalHref,
    logSubfolder,
};
