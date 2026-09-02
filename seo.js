const fs = require("fs");
const { sendTelegram } = require("./telegram");

const STATUS_PATH = "./status.json";
const SITES_PATH = "./sites.json";
const CSV_PATH = "./sites.csv";
const DAILY_QUOTA = 1800;
const INSPECT_SLEEP_MS = 80;
const META_ACCOUNT_KEYS = new Set(["description", "clientSecretsFile"]);
const TG_LIST_CAP = 40;

function loadJson(path, fallback) {
    try {
        if (!fs.existsSync(path)) return fallback;
        return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
        return fallback;
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

function hostFromSiteUrl(siteUrl) {
    try {
        return new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
        return "";
    }
}

function loadCatalogByDomain(csvText) {
    const map = new Map();
    for (const row of parseCsv(csvText)) {
        const domain = String(row.domain || "")
            .trim()
            .toLowerCase();
        if (!domain) continue;
        const account = String(row.account || "").trim();
        const existing = map.get(domain);
        if (!existing) {
            map.set(domain, row);
            continue;
        }
        const existingAccount = String(existing.account || "").trim();
        if (!existingAccount && account) {
            map.set(domain, row);
        }
    }
    return map;
}

function parsePageSlots(pagesField) {
    return String(pagesField || "")
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !s.startsWith("-"))
        .map((s) => s.toLowerCase());
}

function pageUrlForSlot(domain, slot) {
    const s = String(slot || "").toLowerCase();
    if (!s || s === "home") return `https://${domain}/`;
    return `https://${domain}/${s}`;
}

function pageTargetsForRow(domain, catalogRow) {
    const slots = parsePageSlots(catalogRow?.pages);
    const seen = new Set();
    const pages = [];
    const add = (slot) => {
        if (seen.has(slot)) return;
        seen.add(slot);
        pages.push({ slot, url: pageUrlForSlot(domain, slot) });
    };
    add("home");
    for (const slot of slots) add(slot);
    return pages;
}

function uniqueMonitoredHosts(sites) {
    const seen = new Set();
    const out = [];
    for (const site of sites || []) {
        const host = hostFromSiteUrl(site.url);
        if (!host || seen.has(host)) continue;
        seen.add(host);
        out.push({ url: site.url, host });
    }
    return out;
}

function parseClientSecretJson(raw) {
    const json = JSON.parse(raw);
    const block = json.web || json.installed;
    if (!block?.client_id || !block?.client_secret) {
        throw new Error("GSC_CLIENT_SECRET_JSON: нужен объект web.client_id / web.client_secret");
    }
    return block;
}

function parseAccountsJson(raw) {
    const json = JSON.parse(raw);
    const map = new Map();
    for (const [key, val] of Object.entries(json)) {
        if (META_ACCOUNT_KEYS.has(key)) continue;
        const token = val && val.refreshToken;
        if (!token) continue;
        map.set(String(key).trim().toLowerCase(), String(token).trim());
    }
    return map;
}

function loadLocalEnv(filePath = ".env") {
    try {
        if (!fs.existsSync(filePath)) return;
        const text = fs.readFileSync(filePath, "utf8");
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith("#")) continue;
            const eq = line.indexOf("=");
            if (eq < 1) continue;
            const key = line.slice(0, eq).trim();
            if (!key || process.env[key] !== undefined) continue;
            let val = line.slice(eq + 1).trim();
            if (
                (val.startsWith("'") && val.endsWith("'")) ||
                (val.startsWith('"') && val.endsWith('"'))
            ) {
                val = val.slice(1, -1);
            }
            process.env[key] = val;
        }
    } catch {
        // локальный .env опционален
    }
}

function loadSecretsFromEnv(env = process.env) {
    const clientRaw = env.GSC_CLIENT_SECRET_JSON;
    const accountsRaw = env.GSC_ACCOUNTS_JSON;
    if (!clientRaw || !String(clientRaw).trim()) return null;
    if (!accountsRaw || !String(accountsRaw).trim()) return null;
    return {
        client: parseClientSecretJson(clientRaw),
        tokens: parseAccountsJson(accountsRaw),
    };
}

function isIndexed(indexStatus) {
    if (!indexStatus) return false;
    if (indexStatus.verdict === "PASS") return true;
    const coverage = String(indexStatus.coverageState || "").toLowerCase();
    if (!coverage) return false;
    if (coverage.includes("not indexed")) return false;
    return coverage.includes("indexed");
}

function gscErrorStatus(err) {
    const code = err?.code ?? err?.response?.status ?? err?.status;
    const n = Number(code);
    return Number.isFinite(n) ? n : 0;
}

function gscErrorMessage(err) {
    if (!err) return "ошибка GSC";
    const data = err.response?.data || err.errors;
    if (data) {
        try {
            return typeof data === "string" ? data : JSON.stringify(data);
        } catch {
            return String(err.message || err);
        }
    }
    return String(err.message || err);
}

function createQuota(limit) {
    let used = 0;
    return {
        get used() {
            return used;
        },
        remaining() {
            return Math.max(0, limit - used);
        },
        take() {
            if (used >= limit) return false;
            used += 1;
            return true;
        },
    };
}

function pageRecord({ url, slot, inspectJson, error, checkedAt }) {
    const indexStatus = inspectJson?.inspectionResult?.indexStatusResult || {};
    const failed = Boolean(error) || !inspectJson;
    return {
        url,
        slot,
        indexed: failed ? null : isIndexed(indexStatus),
        coverageState: indexStatus.coverageState || null,
        verdict: indexStatus.verdict || null,
        lastCrawlTime: indexStatus.lastCrawlTime || null,
        pageFetchState: indexStatus.pageFetchState || null,
        checked_at: checkedAt,
        error: error || null,
    };
}

function skipIndex(error, checkedAt = new Date().toISOString()) {
    return {
        indexed: null,
        coverageState: null,
        verdict: null,
        lastCrawlTime: null,
        siteUrl: null,
        checked_at: checkedAt,
        error,
        pages_total: 0,
        pages_indexed: 0,
        pages_checked: 0,
        pages: [],
    };
}

function upsertPages(prevPages, updates) {
    const map = new Map();
    for (const page of prevPages || []) {
        if (page?.url) map.set(page.url, page);
    }
    for (const page of updates || []) {
        if (page?.url) map.set(page.url, page);
    }
    return [...map.values()];
}

function buildHostIndex({
    host,
    catalogRow,
    prevIndex,
    updates,
    siteUrl,
    checkedAt,
}) {
    const expected = pageTargetsForRow(host, catalogRow);
    const order = new Map(expected.map((page, i) => [page.url, i]));
    const pages = upsertPages(prevIndex?.pages, updates).sort(
        (a, b) => (order.get(a.url) ?? 999) - (order.get(b.url) ?? 999),
    );
    const home = pages.find((page) => page.slot === "home") || null;
    const decided = pages.filter((page) => page.indexed === true || page.indexed === false);
    return {
        indexed: home ? home.indexed : null,
        coverageState: home?.coverageState ?? null,
        verdict: home?.verdict ?? null,
        lastCrawlTime: home?.lastCrawlTime ?? null,
        siteUrl: siteUrl || prevIndex?.siteUrl || `sc-domain:${host}`,
        checked_at: home?.checked_at || checkedAt,
        error: home?.error ?? null,
        pages_total: expected.length,
        pages_indexed: pages.filter((page) => page.indexed === true).length,
        pages_checked: decided.length,
        pages,
    };
}

function previousPagesByUrl(status) {
    const map = new Map();
    for (const row of status?.data || []) {
        for (const page of row?.index?.pages || []) {
            if (page?.url && !map.has(page.url)) map.set(page.url, page);
        }
    }
    return map;
}

function buildSeoDiff(prevStatus, nextByHost) {
    const prev = previousPagesByUrl(prevStatus);
    const dropped = [];
    const recovered = [];
    const errors = [];

    for (const index of nextByHost.values()) {
        for (const page of index?.pages || []) {
            if (!page?.url) continue;
            const was = prev.get(page.url);
            if (page.error && !was?.error) {
                errors.push(page.url);
            }
            if (was?.indexed === true && page.indexed === false) {
                dropped.push(page.url);
            }
            if (was?.indexed === false && page.indexed === true) {
                recovered.push(page.url);
            }
        }
    }

    return { dropped, recovered, errors };
}

function hasPriorIndex(status) {
    if (status?.index_last_update) return true;
    return (status?.data || []).some((row) => row?.index && row.index.pages);
}

function formatSeoMessage({ isBaseline, diff, stats }) {
    if (isBaseline) {
        return [
            "🔍 *Индексация: база записана*",
            `Главных проверено: ${stats.homesChecked}`,
            `В индексе (главные): ${stats.homesIndexed}`,
            `Страниц проверено сегодня: ${stats.pagesCheckedToday}`,
            `Страниц в индексе (накоплено): ${stats.pagesIndexed}`,
            `Нет в GSC / skip: ${stats.skipped}`,
            "Дальше писать буду только если что-то изменится.",
        ].join("\n");
    }

    const { dropped, recovered, errors } = diff;
    if (!dropped.length && !recovered.length && !errors.length) {
        return null;
    }

    const blocks = ["🔍 *Индексация: изменения*"];
    if (dropped.length) {
        blocks.push(
            `\n📉 *Выпали из индекса (${dropped.length}):*`,
            ...dropped.slice(0, TG_LIST_CAP).map((url) => `   • ${url}`),
        );
    }
    if (recovered.length) {
        blocks.push(
            `\n✅ *Попали в индекс (${recovered.length}):*`,
            ...recovered.slice(0, TG_LIST_CAP).map((url) => `   • ${url}`),
        );
    }
    if (errors.length) {
        blocks.push(
            `\n⚠️ *GSC не ответил (${errors.length}):*`,
            ...errors.slice(0, TG_LIST_CAP).map((url) => `   • ${url}`),
        );
    }
    return blocks.join("\n");
}

function applyIndexToStatusData(data, indexByHost) {
    return (data || []).map((row) => {
        const host = hostFromSiteUrl(row.url);
        if (host && indexByHost.has(host)) {
            return { ...row, index: indexByHost.get(host) };
        }
        return { ...row, index: row.index ?? null };
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function inspectOnce(sc, inspectionUrl, siteUrl) {
    try {
        const res = await sc.urlInspection.index.inspect({
            requestBody: {
                inspectionUrl,
                siteUrl,
            },
        });
        return { ok: true, status: 200, json: res.data, error: null };
    } catch (err) {
        return {
            ok: false,
            status: gscErrorStatus(err),
            json: null,
            error: gscErrorMessage(err),
        };
    }
}

async function inspectUrlWithFallback(inspectFn, inspectionUrl, domain, quota) {
    const primary = `sc-domain:${domain}`;
    if (!quota.take()) {
        return { skipped: true, siteUrl: primary };
    }
    const first = await inspectFn(inspectionUrl, primary);
    if (first.status === 403) {
        const fallback = `https://${domain}/`;
        if (!quota.take()) {
            return {
                ...first,
                siteUrl: primary,
                usedFallback: false,
            };
        }
        const second = await inspectFn(inspectionUrl, fallback);
        return { ...second, siteUrl: fallback, usedFallback: true };
    }
    return { ...first, siteUrl: primary, usedFallback: false };
}

function clientCache(clientBlock) {
    const { google } = require("googleapis");
    const cache = new Map();
    return (accountEmail, refreshToken) => {
        const key = String(accountEmail).toLowerCase();
        if (cache.has(key)) return cache.get(key);
        const auth = new google.auth.OAuth2(
            clientBlock.client_id,
            clientBlock.client_secret,
        );
        auth.setCredentials({ refresh_token: refreshToken });
        const sc = google.searchconsole({ version: "v1", auth });
        cache.set(key, sc);
        return sc;
    };
}

async function runSeo(options = {}) {
    const env = options.env || process.env;
    const secrets = loadSecretsFromEnv(env);
    if (!secrets) {
        console.log(
            "GSC не настроен (нет GSC_CLIENT_SECRET_JSON / GSC_ACCOUNTS_JSON) — пропускаем SEO-проверку",
        );
        return { skipped: true };
    }
    if (!secrets.tokens.size) {
        console.log("GSC_ACCOUNTS_JSON без refresh token — пропускаем SEO-проверку");
        return { skipped: true };
    }

    const sitesPath = options.sitesPath || SITES_PATH;
    const csvPath = options.csvPath || CSV_PATH;
    const statusPath = options.statusPath || STATUS_PATH;

    const sites = JSON.parse(fs.readFileSync(sitesPath, "utf8"));
    const catalog = loadCatalogByDomain(fs.readFileSync(csvPath, "utf8"));
    const prevStatus = loadJson(statusPath, { data: [] });
    const checkedAt = new Date().toISOString();
    const quota = createQuota(options.quotaLimit || DAILY_QUOTA);
    let inspectFn = options.inspectFn;
    if (!inspectFn) {
        const getClient = options.getClient || clientCache(secrets.client);
        inspectFn = (inspectionUrl, siteUrl) => {
            const host =
                hostFromSiteUrl(inspectionUrl) ||
                String(siteUrl).replace(/^sc-domain:/, "");
            const catalogRow = catalog.get(host);
            const account = String(catalogRow?.account || "")
                .trim()
                .toLowerCase();
            const token = secrets.tokens.get(account);
            if (!token) {
                return Promise.resolve({
                    ok: false,
                    status: 0,
                    json: null,
                    error: `нет refresh token для ${account || host}`,
                });
            }
            const sc = getClient(account, token);
            return inspectOnce(sc, inspectionUrl, siteUrl);
        };
    }

    const indexByHost = new Map();
    for (const row of prevStatus.data || []) {
        const host = hostFromSiteUrl(row.url);
        if (host && row.index && !indexByHost.has(host)) {
            indexByHost.set(host, row.index);
        }
    }

    const hosts = uniqueMonitoredHosts(sites);
    const eligible = [];
    const innerQueue = [];
    let skipped = 0;

    for (const item of hosts) {
        const catalogRow = catalog.get(item.host);
        const account = String(catalogRow?.account || "")
            .trim()
            .toLowerCase();
        if (!catalogRow || !account) {
            skipped += 1;
            indexByHost.set(
                item.host,
                skipIndex("нет в sites.csv / нет account", checkedAt),
            );
            continue;
        }
        if (!secrets.tokens.has(account)) {
            skipped += 1;
            indexByHost.set(
                item.host,
                skipIndex(`нет refresh token для ${account}`, checkedAt),
            );
            continue;
        }
        const targets = pageTargetsForRow(item.host, catalogRow);
        eligible.push({
            host: item.host,
            account,
            catalogRow,
            home: targets[0],
            inner: targets.slice(1),
        });
        for (const page of targets.slice(1)) {
            innerQueue.push({ ...page, host: item.host, account });
        }
    }

    async function inspectAndRecord(target, host, catalogRow) {
        const result = await inspectUrlWithFallback(
            inspectFn,
            target.url,
            host,
            quota,
        );
        if (result.skipped) return null;
        const rec = pageRecord({
            url: target.url,
            slot: target.slot,
            inspectJson: result.ok ? result.json : null,
            error: result.ok ? null : result.error || `HTTP ${result.status}`,
            checkedAt,
        });
        const prev = indexByHost.get(host);
        indexByHost.set(
            host,
            buildHostIndex({
                host,
                catalogRow,
                prevIndex: prev,
                updates: [rec],
                siteUrl: result.siteUrl,
                checkedAt,
            }),
        );
        return rec;
    }

    let homesChecked = 0;
    let pagesCheckedToday = 0;

    for (const item of eligible) {
        if (quota.remaining() <= 0) break;
        await inspectAndRecord(item.home, item.host, item.catalogRow);
        homesChecked += 1;
        pagesCheckedToday += 1;
        if (INSPECT_SLEEP_MS && !options.inspectFn) await sleep(INSPECT_SLEEP_MS);
    }

    let cursor = Number(prevStatus.index_queue_cursor) || 0;
    if (innerQueue.length) {
        cursor %= innerQueue.length;
        let n = 0;
        while (quota.remaining() > 0 && n < innerQueue.length) {
            const item = innerQueue[cursor];
            const catalogRow = catalog.get(item.host);
            await inspectAndRecord(item, item.host, catalogRow);
            pagesCheckedToday += 1;
            cursor = (cursor + 1) % innerQueue.length;
            n += 1;
            if (INSPECT_SLEEP_MS && !options.inspectFn) await sleep(INSPECT_SLEEP_MS);
        }
    }

    const nextData = applyIndexToStatusData(
        prevStatus.data && prevStatus.data.length
            ? prevStatus.data
            : sites.map((site) => ({ url: site.url })),
        indexByHost,
    );

    const homesIndexed = [...indexByHost.values()].filter(
        (idx) => idx.indexed === true,
    ).length;
    const pagesIndexed = [...indexByHost.values()].reduce(
        (sum, idx) => sum + (idx.pages_indexed || 0),
        0,
    );

    const isBaseline = !hasPriorIndex(prevStatus);
    const diff = buildSeoDiff(prevStatus, indexByHost);
    const stats = {
        homesChecked,
        homesIndexed,
        pagesCheckedToday,
        pagesIndexed,
        skipped,
        quotaUsed: quota.used,
    };

    const statusData = {
        ...prevStatus,
        index_last_update: checkedAt,
        index_queue_cursor: cursor,
        data: nextData,
    };
    fs.writeFileSync(statusPath, JSON.stringify(statusData, null, 2));

    console.log(
        `SEO: homes=${homesChecked} pages_today=${pagesCheckedToday} indexed_pages=${pagesIndexed} skipped=${skipped} quota=${quota.used}/${DAILY_QUOTA} cursor=${cursor}`,
    );

    const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = env.TELEGRAM_CHAT_ID;
    const message = formatSeoMessage({ isBaseline, diff, stats });
    if (BOT_TOKEN && CHAT_ID && message) {
        try {
            await sendTelegram({ token: BOT_TOKEN, chatId: CHAT_ID, text: message });
            console.log("Telegram: отправлен SEO-отчёт");
        } catch (err) {
            console.error("Ошибка Telegram в SEO:", err);
        }
    } else if (!message) {
        console.log("Telegram: индексация без изменений");
    } else {
        console.log("TELEGRAM не задан — SEO-отчёт только в status.json");
    }

    return { skipped: false, stats, diff, isBaseline, cursor };
}

module.exports = {
    DAILY_QUOTA,
    parseCsv,
    splitCsvLine,
    loadCatalogByDomain,
    hostFromSiteUrl,
    parsePageSlots,
    pageUrlForSlot,
    pageTargetsForRow,
    uniqueMonitoredHosts,
    parseClientSecretJson,
    parseAccountsJson,
    loadLocalEnv,
    loadSecretsFromEnv,
    isIndexed,
    createQuota,
    pageRecord,
    skipIndex,
    upsertPages,
    buildHostIndex,
    buildSeoDiff,
    hasPriorIndex,
    formatSeoMessage,
    applyIndexToStatusData,
    inspectUrlWithFallback,
    runSeo,
};

if (require.main === module) {
    loadLocalEnv();
    runSeo()
        .then((result) => {
            if (result?.skipped) process.exit(0);
        })
        .catch((err) => {
            console.error("SEO-монитор упал:", err);
            process.exit(1);
        });
}
