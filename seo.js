const fs = require("fs");
const dns = require("dns");
const http = require("http");
const https = require("https");
const { sendTelegram } = require("./telegram");

const STATUS_PATH = "./status.json";
const SITES_PATH = "./sites.json";
const CSV_PATH = "./sites.csv";
const DAILY_QUOTA = 1800;
const INSPECT_SLEEP_MS = 80;
const INSPECT_TIMEOUT_MS = 20000;
const AUTH_TIMEOUT_MS = 25000;
const PROBE_TIMEOUT_MS = 15000;
const INSPECT_CONCURRENCY = 2;
const INSPECT_RETRIES = 2;
const STALL_LIMIT = 40;
const SEO_RETRY_WAIT_MS = 120000;
const GSC_INSPECT_HOST = "searchconsole.googleapis.com";
const GSC_INSPECT_PATH = "/v1/urlInspection/index:inspect";
const META_ACCOUNT_KEYS = new Set(["description", "clientSecretsFile"]);
const TG_LIST_CAP = 40;

function preferIpv4() {
    try {
        dns.setDefaultResultOrder("ipv4first");
    } catch {
        // Node < 17
    }
    if (http.globalAgent && http.globalAgent.options) {
        http.globalAgent.options.family = 4;
    }
    if (https.globalAgent && https.globalAgent.options) {
        https.globalAgent.options.family = 4;
    }
}

preferIpv4();

function logSeo(message) {
    const line = `${new Date().toISOString()} ${message}\n`;
    try {
        process.stderr.write(line);
    } catch {
        // ignore
    }
    try {
        process.stdout.write(line);
    } catch {
        // ignore
    }
}

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

const SITEMAP_TIMEOUT_MS = 15000;
const SITEMAP_MAX_URLS = 30;
const SITEMAP_CONCURRENCY = 8;
const SITEMAP_MAX_CHILDREN = 5;

function decodeXmlEntities(text) {
    return String(text || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .trim();
}

function parseSitemapXml(xml) {
    const text = String(xml || "");
    const locs = [];
    const re = /<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi;
    let m;
    while ((m = re.exec(text))) {
        const loc = decodeXmlEntities(m[1]);
        if (loc) locs.push(loc);
    }
    const isIndex = /<sitemapindex[\s>]/i.test(text);
    return isIndex ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

function slotFromUrl(url) {
    try {
        const path = new URL(url).pathname || "/";
        if (path === "/" || path === "") return "home";
        return path.replace(/^\/+|\/+$/g, "").toLowerCase() || "home";
    } catch {
        return String(url);
    }
}

function sitemapTargets(host, urls, cap = SITEMAP_MAX_URLS) {
    const home = { slot: "home", url: `https://${host}/` };
    const seen = new Set([home.url]);
    const inner = [];
    for (const raw of urls || []) {
        let parsed;
        try {
            parsed = new URL(String(raw).trim());
        } catch {
            continue;
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
        if (hostFromSiteUrl(parsed.href) !== host) continue;
        const path = parsed.pathname || "/";
        if (path === "/" || path === "") continue;
        if (/^\/visit(\/|$)/i.test(path)) continue;
        if (/\.(xml|txt|jpg|jpeg|png|gif|webp|svg|pdf|css|js)$/i.test(path)) continue;
        const clean = `https://${host}${path}`;
        if (seen.has(clean)) continue;
        seen.add(clean);
        inner.push({ slot: slotFromUrl(clean), url: clean });
        if (inner.length >= cap) break;
    }
    return [home, ...inner];
}

function httpsGetText(url, { timeoutMs = SITEMAP_TIMEOUT_MS, redirects = 3 } = {}) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        } catch (err) {
            reject(err);
            return;
        }
        const lib = target.protocol === "http:" ? http : https;
        const req = lib.get(
            target,
            {
                family: 4,
                timeout: timeoutMs,
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                    Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
                },
            },
            (res) => {
                const status = res.statusCode || 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    if (redirects <= 0) {
                        reject(new Error("too many redirects"));
                        return;
                    }
                    const next = new URL(res.headers.location, target).href;
                    httpsGetText(next, { timeoutMs, redirects: redirects - 1 })
                        .then(resolve)
                        .catch(reject);
                    return;
                }
                const chunks = [];
                let size = 0;
                res.on("data", (chunk) => {
                    size += chunk.length;
                    if (size > 2_000_000) {
                        req.destroy();
                        reject(new Error("sitemap too large"));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on("end", () => {
                    resolve({ status, text: Buffer.concat(chunks).toString("utf8") });
                });
            },
        );
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("sitemap timeout"));
        });
        req.on("error", reject);
    });
}

async function fetchSitemapUrls(host) {
    const started = Date.now();
    try {
        const first = await httpsGetText(`https://${host}/sitemap.xml`);
        if (first.status !== 200) {
            return { urls: [], error: `sitemap HTTP ${first.status}`, ms: Date.now() - started };
        }
        const parsed = parseSitemapXml(first.text);
        let urls = parsed.urls;
        if (!urls.length && parsed.sitemaps.length) {
            for (const child of parsed.sitemaps.slice(0, SITEMAP_MAX_CHILDREN)) {
                try {
                    const res = await httpsGetText(child);
                    if (res.status === 200) urls = urls.concat(parseSitemapXml(res.text).urls);
                } catch {
                    // один битый дочерний sitemap не валит остальные
                }
                if (urls.length >= SITEMAP_MAX_URLS * 2) break;
            }
        }
        if (!urls.length) {
            return { urls: [], error: "sitemap пустой", ms: Date.now() - started };
        }
        return { urls, error: null, ms: Date.now() - started };
    } catch (err) {
        return { urls: [], error: String(err?.message || err), ms: Date.now() - started };
    }
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

function mergePageRecord(prev, next) {
    if (!next) return prev;
    if (!next.error || !prev) return next;
    const hadStatus = prev.indexed === true || prev.indexed === false;
    if (!hadStatus) return next;
    // Google сегодня не ответил — оставляем вчерашний статус, ошибку помечаем отдельно.
    return {
        ...next,
        indexed: prev.indexed,
        coverageState: prev.coverageState ?? null,
        verdict: prev.verdict ?? null,
        lastCrawlTime: prev.lastCrawlTime ?? null,
        pageFetchState: prev.pageFetchState ?? null,
        status_from: prev.status_from || prev.checked_at || null,
        stale: true,
    };
}

function upsertPages(prevPages, updates) {
    const map = new Map();
    for (const page of prevPages || []) {
        if (page?.url) map.set(page.url, page);
    }
    for (const page of updates || []) {
        if (page?.url) map.set(page.url, mergePageRecord(map.get(page.url), page));
    }
    return [...map.values()];
}

function isNoindexCoverage(coverageState) {
    return String(coverageState || "").toLowerCase().includes("noindex");
}

function buildHostIndex({
    host,
    catalogRow,
    targets,
    sitemap,
    prevIndex,
    updates,
    siteUrl,
    checkedAt,
}) {
    const expected = targets || pageTargetsForRow(host, catalogRow);
    const order = new Map(expected.map((page, i) => [page.url, i]));
    let pages = upsertPages(prevIndex?.pages, updates);
    if (targets) {
        // Источник URL — sitemap: чужие / устаревшие адреса из старой базы убираем.
        pages = pages.filter((page) => order.has(page.url));
    }
    pages.sort((a, b) => (order.get(a.url) ?? 999) - (order.get(b.url) ?? 999));
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
        noindex: home ? isNoindexCoverage(home.coverageState) : false,
        pages_total: expected.length,
        pages_indexed: pages.filter((page) => page.indexed === true).length,
        pages_checked: decided.length,
        sitemap: sitemap ?? prevIndex?.sitemap ?? null,
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
    const reasons = {};

    for (const index of nextByHost.values()) {
        for (const page of index?.pages || []) {
            if (!page?.url) continue;
            const was = prev.get(page.url);
            if (page.error && !was?.error) {
                errors.push(page.url);
                reasons[page.url] = String(page.error).split(":")[0].trim();
            }
            if (was?.indexed === true && page.indexed === false) {
                dropped.push(page.url);
                if (page.coverageState) reasons[page.url] = page.coverageState;
            }
            if (was?.indexed === false && page.indexed === true) {
                recovered.push(page.url);
            }
        }
    }

    return { dropped, recovered, errors, reasons };
}

function hasPriorIndex(status) {
    return (status?.data || []).some((row) =>
        (row?.index?.pages || []).some(
            (page) => page && (page.indexed === true || page.indexed === false),
        ),
    );
}

function hasSitemapIndex(status) {
    return (status?.data || []).some((row) => row?.index?.sitemap);
}

function formatIndexedUrl(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./i, "");
        const path = parsed.pathname || "/";
        if (path === "/" || path === "") return `${host}/ — главная`;
        return `${host}${path}`;
    } catch {
        return url;
    }
}

function formatUrlBulletList(urls, reasons = {}) {
    const shown = urls.slice(0, TG_LIST_CAP).map((url) => {
        const reason = reasons[url];
        return reason
            ? `   • ${formatIndexedUrl(url)} (${reason})`
            : `   • ${formatIndexedUrl(url)}`;
    });
    if (urls.length > TG_LIST_CAP) {
        shown.push(`   … и ещё ${urls.length - TG_LIST_CAP}`);
    }
    return shown;
}

function formatChangeBlocks(diff) {
    const { dropped = [], recovered = [], errors = [], reasons = {} } = diff || {};
    const blocks = [];
    if (dropped.length) {
        blocks.push(
            `\n📉 *Выпали из индекса (${dropped.length}):*`,
            ...formatUrlBulletList(dropped, reasons),
        );
    }
    if (recovered.length) {
        blocks.push(
            `\n✅ *Появились в индексе (${recovered.length}):*`,
            ...formatUrlBulletList(recovered),
        );
    }
    if (errors.length) {
        blocks.push(
            `\n⚠️ *Google не ответил (${errors.length}), прежний статус не сброшен:*`,
            ...formatUrlBulletList(errors, reasons),
        );
    }
    return blocks;
}

function formatSeoMessage({ isBaseline, diff, stats }) {
    if (isBaseline) {
        const eligible = stats.eligible ?? stats.homesChecked ?? 0;
        const innerChecked =
            stats.innerChecked ??
            Math.max(0, (stats.pagesCheckedToday || 0) - (stats.homesChecked || 0));
        const innerIndexed =
            stats.innerIndexed ??
            Math.max(0, (stats.pagesIndexed || 0) - (stats.homesIndexed || 0));
        const innerTotal = stats.innerTotal;
        const lines = [
            "🔍 *Индексация Google*",
            "",
            "*Главные* (`https://сайт/`)",
            `• проверено: ${stats.homesChecked} из ${eligible}`,
            `• в индексе: ${stats.homesIndexed}`,
            `• не в индексе: ${stats.homesNotIndexed ?? 0}`,
        ];
        if (stats.homesNoindex) {
            lines.push(`   из них noindex (сайт сам запрещает): ${stats.homesNoindex}`);
        }
        lines.push(`• Google не ответил: ${stats.homesErrors ?? 0}`);
        lines.push(
            "",
            "*Внутренние* (адреса из sitemap сайта)",
            `• проверено сегодня: ${innerChecked}`,
            `• в индексе: ${innerIndexed}`,
        );
        if (stats.innerNotIndexed != null) {
            lines.push(`• не в индексе: ${stats.innerNotIndexed}`);
        }
        if (innerTotal != null && innerTotal > innerChecked) {
            lines.push(`• остальные (${innerTotal - innerChecked}) — в следующие дни`);
        }
        if (stats.sitemapMissing) {
            lines.push(`• без sitemap.xml (только главная): ${stats.sitemapMissing}`);
        }
        lines.push("", `Не проверялись (нет кабинета Google): ${stats.skipped}`);
        if (stats.stalled) {
            lines.push(
                "",
                "⚠️ Проверка неполная: Google с GitHub не отвечал. Цифры только по тому, что успели спросить.",
            );
        }
        const changes = formatChangeBlocks({
            dropped: diff?.dropped || [],
            recovered: diff?.recovered || [],
            errors: [],
            reasons: diff?.reasons || {},
        });
        if (changes.length) lines.push(...changes);
        if (!stats.stalled) {
            lines.push(
                "",
                "Дальше напишу, только если страница выпадет или появится в индексе.",
            );
        }
        return lines.join("\n");
    }

    const blocks = formatChangeBlocks(diff);
    if (!blocks.length) return null;
    return ["🔍 *Индексация — изменения*", ...blocks].join("\n");
}

function formatAuthFailMessage({ eligible, skipped, detail }) {
    return [
        "🔍 *Индексация: проверка не началась*",
        "Не удалось войти в Google. Это не список сайтов.",
        detail ? `Причина: ${detail}` : null,
        `Сайтов в списке: ${eligible}, без кабинета: ${skipped}`,
    ]
        .filter(Boolean)
        .join("\n");
}

function formatRetryNotice() {
    return [
        "🔍 *Индексация: проверка оборвалась*",
        "Через 2 минуты запускаю ещё раз (одна попытка).",
    ].join("\n");
}

function isPermanentAuthError(detail) {
    const text = String(detail || "").toLowerCase();
    return (
        text.includes("invalid_client") ||
        text.includes("invalid_grant") ||
        text.includes("unauthorized") ||
        text.includes("permission_denied")
    );
}

function shouldRetrySeo(result) {
    if (!result || result.skipped) return false;
    if (result.stats?.stalledReason === "auth") {
        return !isPermanentAuthError(result.stats.authDetail);
    }
    return Boolean(result.stalled);
}

async function notifySeo(env, text) {
    if (!text) {
        console.log("Telegram: индексация без изменений");
        return;
    }
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        console.log("TELEGRAM не задан — SEO-отчёт только в status.json");
        return;
    }
    await sendTelegram({ token, chatId, text });
    console.log("Telegram: отправлен SEO-отчёт");
}

function telegramTextFromResult(result) {
    if (!result || result.skipped) return null;
    if (result.stats?.stalledReason === "auth") {
        return formatAuthFailMessage({
            eligible: result.stats.eligible,
            skipped: result.stats.skipped,
            detail: result.stats.authDetail,
        });
    }
    return formatSeoMessage({
        isBaseline: result.isBaseline,
        diff: result.diff || { dropped: [], recovered: [], errors: [] },
        stats: result.stats || {},
    });
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

async function withTimeout(promise, ms, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const err = new Error(label);
                    err.code = 408;
                    reject(err);
                }, ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function isTimeoutError(err) {
    const code = String(err?.code || "").toUpperCase();
    const msg = String(err?.message || "").toLowerCase();
    return (
        code === "408" ||
        code === "ETIMEOUT" ||
        code === "ETIMEDOUT" ||
        msg.includes("timeout")
    );
}

function inspectHttpError(status, json, text) {
    const err = json && json.error;
    if (err && typeof err === "object") {
        return [err.status, err.message].filter(Boolean).join(": ") || `HTTP ${status}`;
    }
    if (typeof err === "string" && err.trim()) return err.trim();
    const slice = String(text || "").trim().slice(0, 180);
    return slice || `HTTP ${status}`;
}

function httpsPostJson({ hostname, path, body, accessToken, timeoutMs }) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname,
                path,
                method: "POST",
                family: 4,
                timeout: timeoutMs,
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    let json = null;
                    try {
                        json = JSON.parse(text);
                    } catch {
                        json = null;
                    }
                    resolve({ status: res.statusCode, json, text });
                });
            },
        );
        req.on("timeout", () => {
            req.destroy();
            const err = new Error("GSC inspect timeout");
            err.code = 408;
            reject(err);
        });
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

async function inspectOnce(auth, inspectionUrl, siteUrl) {
    const started = Date.now();
    try {
        const got = await withTimeout(
            Promise.resolve(auth.getAccessToken()),
            AUTH_TIMEOUT_MS,
            "GSC auth timeout",
        );
        const access = typeof got === "string" ? got : got && got.token;
        if (!access) throw new Error("empty access token");
        const res = await withTimeout(
            httpsPostJson({
                hostname: GSC_INSPECT_HOST,
                path: GSC_INSPECT_PATH,
                body: { inspectionUrl, siteUrl },
                accessToken: access,
                timeoutMs: INSPECT_TIMEOUT_MS,
            }),
            INSPECT_TIMEOUT_MS + 2000,
            "GSC inspect timeout",
        );
        const ms = Date.now() - started;
        if (res.status >= 200 && res.status < 300 && res.json) {
            logSeo(`SEO inspect HTTP ${res.status} ${ms}ms ${inspectionUrl}`);
            return { ok: true, status: res.status, json: res.json, error: null };
        }
        const error = inspectHttpError(res.status, res.json, res.text);
        logSeo(`SEO inspect HTTP ${res.status} ${ms}ms ${inspectionUrl} ${error}`);
        return {
            ok: false,
            status: res.status,
            json: res.json,
            error,
        };
    } catch (err) {
        const ms = Date.now() - started;
        logSeo(`SEO inspect ERR ${ms}ms ${inspectionUrl}: ${authErrorText(err)}`);
        return {
            ok: false,
            status: isTimeoutError(err) ? 408 : gscErrorStatus(err),
            json: null,
            error: isTimeoutError(err)
                ? `таймаут GSC (${INSPECT_TIMEOUT_MS / 1000}с)`
                : gscErrorMessage(err),
        };
    }
}

async function inspectOnceWithRetry(auth, inspectionUrl, siteUrl) {
    let last = { ok: false, status: 0, json: null, error: "no attempt" };
    for (let attempt = 1; attempt <= INSPECT_RETRIES; attempt += 1) {
        last = await inspectOnce(auth, inspectionUrl, siteUrl);
        if (last.ok || last.status !== 408) return last;
        logSeo(
            `SEO retry ${attempt}/${INSPECT_RETRIES} timeout ${inspectionUrl}`,
        );
        await sleep(1500 * attempt);
    }
    return last;
}

function authErrorText(err) {
    const data = err?.response?.data;
    if (data && typeof data === "object") {
        return [data.error, data.error_description].filter(Boolean).join(": ");
    }
    if (typeof data === "string" && data.trim()) return data.trim().slice(0, 180);
    return String(err?.message || err);
}

async function probeGoogleIpv4() {
    const started = Date.now();
    try {
        const status = await withTimeout(
            new Promise((resolve, reject) => {
                const req = https.get(
                    "https://oauth2.googleapis.com/",
                    { family: 4, timeout: PROBE_TIMEOUT_MS },
                    (res) => {
                        res.resume();
                        resolve(res.statusCode);
                    },
                );
                req.on("error", reject);
                req.on("timeout", () => {
                    req.destroy();
                    reject(new Error("Google IPv4 probe timeout"));
                });
            }),
            PROBE_TIMEOUT_MS + 2000,
            "Google IPv4 probe timeout",
        );
        logSeo(
            `SEO network probe ipv4 oauth2.googleapis.com HTTP ${status} ${Date.now() - started}ms`,
        );
        return true;
    } catch (err) {
        logSeo(
            `SEO network probe FAIL: ${err.message || err} ${Date.now() - started}ms`,
        );
        return false;
    }
}

async function warmupAccounts(getClient, secrets) {
    const entries = [...secrets.tokens.entries()];
    const results = await Promise.all(
        entries.map(async ([email, token]) => {
            try {
                const { auth } = getClient(email, token);
                const got = await withTimeout(
                    Promise.resolve(auth.getAccessToken()),
                    AUTH_TIMEOUT_MS,
                    "GSC auth timeout",
                );
                const access =
                    typeof got === "string" ? got : got && got.token;
                if (!access) throw new Error("empty access token");
                logSeo(`SEO auth ok ${email}`);
                return { ok: true, email, error: null };
            } catch (err) {
                const error = authErrorText(err);
                logSeo(`SEO auth FAIL ${email}: ${error}`);
                return { ok: false, email, error };
            }
        }),
    );
    const failures = results.filter((row) => !row.ok);
    return {
        ok: results.length - failures.length,
        total: results.length,
        sampleError: failures[0]?.error || null,
    };
}

async function runPool(items, concurrency, worker) {
    let next = 0;
    const n = Math.max(1, Math.min(concurrency, items.length || 1));
    await Promise.all(
        Array.from({ length: n }, async () => {
            while (true) {
                const i = next;
                next += 1;
                if (i >= items.length) return;
                const stop = await worker(items[i], i);
                if (stop) return;
            }
        }),
    );
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
        // googleapis freeze'ит клиент — вешать auth на sc.oauth2 нельзя
        const sc = google.searchconsole({ version: "v1", auth });
        const pair = { sc, auth };
        cache.set(key, pair);
        return pair;
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
    logSeo(
        `SEO secrets: client_bytes=${String(env.GSC_CLIENT_SECRET_JSON).length} accounts_bytes=${String(env.GSC_ACCOUNTS_JSON).length} tokens=${secrets.tokens.size}`,
    );

    const sitesPath = options.sitesPath || SITES_PATH;
    const csvPath = options.csvPath || CSV_PATH;
    const statusPath = options.statusPath || STATUS_PATH;

    const sites = JSON.parse(fs.readFileSync(sitesPath, "utf8"));
    const catalog = loadCatalogByDomain(fs.readFileSync(csvPath, "utf8"));
    const prevStatus = loadJson(statusPath, { data: [] });
    const checkedAt = new Date().toISOString();
    const quota = createQuota(options.quotaLimit || DAILY_QUOTA);
    let inspectFn = options.inspectFn;
    let getClient = options.getClient;
    if (!inspectFn) {
        getClient = getClient || clientCache(secrets.client);
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
            const { auth } = getClient(account, token);
            return inspectOnceWithRetry(auth, inspectionUrl, siteUrl);
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
        eligible.push({ host: item.host, account, catalogRow });
    }

    // Внутренние страницы берём из sitemap.xml сайта: имена слотов в CSV
    // (login/bonus…) не совпадают с реальными путями (/accedi/, /registration/…).
    const sitemapFn =
        options.sitemapFn === undefined ? fetchSitemapUrls : options.sitemapFn;
    const targetsByHost = new Map();
    const sitemapByHost = new Map();
    let sitemapLive = 0;
    let sitemapCached = 0;
    let sitemapMissing = 0;

    if (sitemapFn) {
        await runPool(eligible, SITEMAP_CONCURRENCY, async (item) => {
            const res = await sitemapFn(item.host);
            const cached = indexByHost.get(item.host)?.sitemap;
            if (res?.urls?.length) {
                sitemapLive += 1;
                const targets = sitemapTargets(item.host, res.urls);
                targetsByHost.set(item.host, targets);
                sitemapByHost.set(item.host, {
                    urls: targets.slice(1).map((page) => page.url),
                    fetched_at: checkedAt,
                    error: null,
                    source: "live",
                });
            } else if (cached?.urls?.length) {
                sitemapCached += 1;
                targetsByHost.set(item.host, sitemapTargets(item.host, cached.urls));
                sitemapByHost.set(item.host, {
                    ...cached,
                    error: res?.error || "sitemap недоступен",
                    source: "cache",
                });
            } else {
                sitemapMissing += 1;
                targetsByHost.set(item.host, sitemapTargets(item.host, []));
                sitemapByHost.set(item.host, {
                    urls: [],
                    fetched_at: checkedAt,
                    error: res?.error || "sitemap пустой",
                    source: "none",
                });
            }
            return false;
        });
        logSeo(
            `SEO sitemaps: live=${sitemapLive} cached=${sitemapCached} none=${sitemapMissing}`,
        );
    } else {
        for (const item of eligible) {
            targetsByHost.set(item.host, pageTargetsForRow(item.host, item.catalogRow));
        }
    }

    for (const item of eligible) {
        const targets = targetsByHost.get(item.host);
        item.home = targets[0];
        item.inner = targets.slice(1);
        for (const page of item.inner) {
            innerQueue.push({ ...page, host: item.host, account: item.account });
        }
    }

    const concurrency = options.inspectFn
        ? 1
        : options.concurrency || INSPECT_CONCURRENCY;
    logSeo(
        `SEO start: hosts=${hosts.length} eligible=${eligible.length} inner=${innerQueue.length} skipped=${skipped} concurrency=${concurrency}`,
    );

    async function abortUnreachable(detail) {
        logSeo(`SEO abort: ${detail}`);
        const stats = {
            homesChecked: 0,
            skipped,
            eligible: eligible.length,
            stalled: true,
            stalledReason: "auth",
            authDetail: detail,
        };
        const message = formatAuthFailMessage({
            eligible: eligible.length,
            skipped,
            detail,
        });
        if (options.notify !== false) {
            const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
            const CHAT_ID = env.TELEGRAM_CHAT_ID;
            if (BOT_TOKEN && CHAT_ID) {
                await sendTelegram({
                    token: BOT_TOKEN,
                    chatId: CHAT_ID,
                    text: message,
                });
            }
        }
        return {
            skipped: false,
            stats,
            isBaseline: false,
            stalled: true,
            wroteStatus: false,
            message,
        };
    }

    if (!options.inspectFn) {
        const netOk = await probeGoogleIpv4();
        if (!netOk) {
            logSeo("SEO network probe failed, всё равно пробуем OAuth");
        }
        const auth = await warmupAccounts(getClient, secrets);
        logSeo(`SEO auth warmup: ${auth.ok}/${auth.total}`);
        if (auth.ok === 0) {
            return abortUnreachable(auth.sampleError || "все GSC-аккаунты отклонены");
        }
    }

    let inspectLock = Promise.resolve();
    function withIndexLock(fn) {
        const prev = inspectLock;
        let release;
        inspectLock = new Promise((resolve) => {
            release = resolve;
        });
        return prev.then(fn).finally(() => release());
    }

    let consecutiveTimeouts = 0;
    let stalled = false;

    async function inspectAndRecord(target, host, catalogRow) {
        const result = await inspectUrlWithFallback(
            inspectFn,
            target.url,
            host,
            quota,
        );
        if (result.skipped) return null;
        const timedOut = result.status === 408;
        consecutiveTimeouts = timedOut ? consecutiveTimeouts + 1 : 0;
        if (consecutiveTimeouts >= STALL_LIMIT) {
            stalled = true;
            logSeo(
                `SEO abort: ${STALL_LIMIT} таймаутов подряд, дальше Google не отвечает`,
            );
        }
        const rec = pageRecord({
            url: target.url,
            slot: target.slot,
            inspectJson: result.ok ? result.json : null,
            error: result.ok ? null : result.error || `HTTP ${result.status}`,
            checkedAt,
        });
        await withIndexLock(async () => {
            const prev = indexByHost.get(host);
            indexByHost.set(
                host,
                buildHostIndex({
                    host,
                    catalogRow,
                    targets: sitemapFn ? targetsByHost.get(host) : undefined,
                    sitemap: sitemapByHost.get(host),
                    prevIndex: prev,
                    updates: [rec],
                    siteUrl: result.siteUrl,
                    checkedAt,
                }),
            );
        });
        return rec;
    }

    let homesChecked = 0;
    let pagesCheckedToday = 0;

    await runPool(eligible, concurrency, async (item) => {
        if (stalled || quota.remaining() <= 0) return true;
        await inspectAndRecord(item.home, item.host, item.catalogRow);
        homesChecked += 1;
        pagesCheckedToday += 1;
        if (pagesCheckedToday === 1 || pagesCheckedToday % 10 === 0) {
            logSeo(
                `SEO progress: ${pagesCheckedToday} ok, homes=${homesChecked}, quota=${quota.used}, last=${item.host}`,
            );
        }
        if (INSPECT_SLEEP_MS && !options.inspectFn) await sleep(INSPECT_SLEEP_MS);
        return stalled;
    });

    logSeo(`SEO homes done: ${homesChecked}, quota=${quota.used}`);

    let cursor = Number(prevStatus.index_queue_cursor) || 0;
    if (innerQueue.length && !stalled && quota.remaining() > 0) {
        cursor %= innerQueue.length;
        let n = 0;
        const innerItems = [];
        while (n < innerQueue.length) {
            innerItems.push(innerQueue[cursor]);
            cursor = (cursor + 1) % innerQueue.length;
            n += 1;
        }
        let innerDone = 0;
        await runPool(innerItems, concurrency, async (item) => {
            if (stalled || quota.remaining() <= 0) return true;
            const catalogRow = catalog.get(item.host);
            await inspectAndRecord(item, item.host, catalogRow);
            innerDone += 1;
            pagesCheckedToday += 1;
            if (pagesCheckedToday % 10 === 0) {
                logSeo(
                    `SEO progress: ${pagesCheckedToday} ok, inner=${innerDone}, quota=${quota.used}, last=${item.url}`,
                );
            }
            if (INSPECT_SLEEP_MS && !options.inspectFn) await sleep(INSPECT_SLEEP_MS);
            return stalled;
        });
        const consumed = Math.min(innerDone, innerItems.length);
        const startCursor = Number(prevStatus.index_queue_cursor) || 0;
        cursor = innerQueue.length
            ? (startCursor + consumed) % innerQueue.length
            : 0;
    }

    const nextData = applyIndexToStatusData(
        prevStatus.data && prevStatus.data.length
            ? prevStatus.data
            : sites.map((site) => ({ url: site.url })),
        indexByHost,
    );

    // Сводку шлём в первый прогон и один раз после перехода на sitemap-адреса,
    // дальше — только изменения.
    const isBaseline =
        !hasPriorIndex(prevStatus) || (Boolean(sitemapFn) && !hasSitemapIndex(prevStatus));
    const diff = buildSeoDiff(prevStatus, indexByHost);

    let homesIndexed = 0;
    let homesNotIndexed = 0;
    let homesNoindex = 0;
    let homesErrors = 0;
    let innerIndexed = 0;
    let innerNotIndexed = 0;
    for (const item of eligible) {
        const idx = indexByHost.get(item.host);
        const home = (idx?.pages || []).find((page) => page.slot === "home");
        if (!home || home.checked_at !== checkedAt) continue;
        if (home.error) homesErrors += 1;
        if (home.indexed === true) homesIndexed += 1;
        else if (home.indexed === false) {
            homesNotIndexed += 1;
            if (isNoindexCoverage(home.coverageState)) homesNoindex += 1;
        }
    }
    for (const idx of indexByHost.values()) {
        for (const page of idx?.pages || []) {
            if (page.slot === "home") continue;
            if (page.checked_at !== checkedAt) continue;
            if (page.indexed === true) innerIndexed += 1;
            else if (page.indexed === false) innerNotIndexed += 1;
        }
    }
    const innerChecked = Math.max(0, pagesCheckedToday - homesChecked);
    const pagesIndexed = [...indexByHost.values()].reduce(
        (sum, idx) => sum + (idx.pages_indexed || 0),
        0,
    );

    const stats = {
        homesChecked,
        homesIndexed,
        homesNotIndexed,
        homesNoindex,
        homesErrors,
        pagesCheckedToday,
        pagesIndexed,
        innerChecked,
        innerIndexed,
        innerNotIndexed,
        innerTotal: innerQueue.length,
        sitemapLive,
        sitemapCached,
        sitemapMissing,
        skipped,
        quotaUsed: quota.used,
        eligible: eligible.length,
        stalled,
        stalledReason: stalled ? "inspect" : undefined,
    };

    const wroteStatus = !(options.skipStatusIfStalled && stalled);
    if (wroteStatus) {
        const statusData = {
            ...prevStatus,
            index_last_update: checkedAt,
            index_queue_cursor: cursor,
            data: nextData,
        };
        fs.writeFileSync(statusPath, JSON.stringify(statusData, null, 2));
    } else {
        logSeo("SEO skip status.json: прогон оборван, будет повтор");
    }

    logSeo(
        `SEO: homes=${homesChecked} pages_today=${pagesCheckedToday} indexed_pages=${pagesIndexed} skipped=${skipped} quota=${quota.used}/${DAILY_QUOTA} cursor=${cursor}${stalled ? " STALLED" : ""}`,
    );

    const message = formatSeoMessage({ isBaseline, diff, stats });
    if (options.notify !== false) {
        const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = env.TELEGRAM_CHAT_ID;
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
    }

    return {
        skipped: false,
        stats,
        diff,
        isBaseline,
        cursor,
        stalled,
        wroteStatus,
        message,
    };
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
    parseSitemapXml,
    sitemapTargets,
    slotFromUrl,
    fetchSitemapUrls,
    mergePageRecord,
    hasSitemapIndex,
    isNoindexCoverage,
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
    formatAuthFailMessage,
    formatRetryNotice,
    formatIndexedUrl,
    shouldRetrySeo,
    isPermanentAuthError,
    telegramTextFromResult,
    applyIndexToStatusData,
    inspectUrlWithFallback,
    inspectHttpError,
    withTimeout,
    runSeo,
};

if (require.main === module) {
    loadLocalEnv();
    (async () => {
        const env = process.env;
        const first = await runSeo({ notify: false, skipStatusIfStalled: true });
        if (first?.skipped) return;
        if (shouldRetrySeo(first)) {
            logSeo("SEO will retry once after wait");
            try {
                await notifySeo(env, formatRetryNotice());
            } catch (err) {
                console.error("Ошибка Telegram (повтор):", err);
            }
            const waitMs = Number(env.SEO_RETRY_WAIT_MS || SEO_RETRY_WAIT_MS);
            if (waitMs > 0) await sleep(waitMs);
            const second = await runSeo({ notify: false });
            try {
                await notifySeo(env, telegramTextFromResult(second));
            } catch (err) {
                console.error("Ошибка Telegram в SEO:", err);
            }
            return;
        }
        try {
            await notifySeo(env, telegramTextFromResult(first));
        } catch (err) {
            console.error("Ошибка Telegram в SEO:", err);
        }
    })().catch((err) => {
        console.error("SEO-монитор упал:", err);
        process.exit(1);
    });
}
