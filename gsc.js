/**
 * Динамика Google Search Console: последние 14 дней против предыдущих 14.
 * Пишет `gsc` в каждую строку status.json. Квоту URL Inspection не трогает.
 */
const fs = require("fs");
const {
    hostFromSiteUrl,
    loadCatalogByDomain,
    loadLocalEnv,
    loadSecretsFromEnv,
    uniqueMonitoredHosts,
} = require("./seo");

const STATUS_PATH = "./status.json";
const SITES_PATH = "./sites.json";
const CSV_PATH = "./sites.csv";
const TZ = "America/Los_Angeles";
const QUERY_TIMEOUT_MS = 30000;

function ymdInPt(date) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date);
}

function addDays(ymd, days) {
    const [y, m, d] = ymd.split("-").map(Number);
    const utc = new Date(Date.UTC(y, m - 1, d));
    utc.setUTCDate(utc.getUTCDate() + days);
    return utc.toISOString().slice(0, 10);
}

/**
 * 14 дней, как на seodrug. Конец — третий день назад по времени Search Console:
 * свежие сутки там ещё не входят в итог.
 */
function gscWindows(now = new Date()) {
    const end = addDays(ymdInPt(now), -3);
    const start = addDays(end, -13);
    const prevEnd = addDays(start, -1);
    const prevStart = addDays(prevEnd, -13);
    return { start, end, prevStart, prevEnd };
}

function sumWindow(rows, start, end) {
    let clicks = 0;
    let impressions = 0;
    let posSum = 0;
    let posDays = 0;
    for (const row of rows || []) {
        const day = row.keys && row.keys[0];
        if (!day || day < start || day > end) continue;
        const imp = Number(row.impressions) || 0;
        const clk = Number(row.clicks) || 0;
        const pos = Number(row.position);
        clicks += clk;
        impressions += imp;
        if (Number.isFinite(pos)) {
            posSum += pos;
            posDays += 1;
        }
    }
    return {
        clicks,
        impressions,
        ctr: impressions ? clicks / impressions : null,
        position: posDays ? Math.round((posSum / posDays) * 100) / 100 : null,
    };
}

function gscErrorStatus(err) {
    const code = err?.code ?? err?.response?.status ?? err?.status;
    const n = Number(code);
    return Number.isFinite(n) ? n : 0;
}

function gscErrorMessage(err) {
    if (!err) return "ошибка GSC";
    const data = err.response?.data;
    const msg = data?.error?.message || data?.message;
    if (msg) return String(msg);
    return String(err.message || err);
}

function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => {
                const err = new Error(label);
                err.code = 408;
                reject(err);
            }, ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

function clientCache(clientBlock) {
    const { google } = require("googleapis");
    const cache = new Map();
    return (accountEmail, refreshToken) => {
        const key = String(accountEmail).toLowerCase();
        if (cache.has(key)) return cache.get(key);
        const auth = new google.auth.OAuth2(clientBlock.client_id, clientBlock.client_secret);
        auth.setCredentials({ refresh_token: refreshToken });
        const sc = google.searchconsole({ version: "v1", auth });
        const pair = { sc, auth };
        cache.set(key, pair);
        return pair;
    };
}

async function queryDaily(sc, siteUrl, startDate, endDate) {
    const res = await withTimeout(
        sc.searchanalytics.query({
            siteUrl,
            requestBody: {
                startDate,
                endDate,
                dimensions: ["date"],
                type: "web",
                dataState: "all",
                rowLimit: 50,
            },
        }),
        QUERY_TIMEOUT_MS,
        "searchanalytics timeout",
    );
    return res.data?.rows || [];
}

async function queryWithFallback(sc, domain, windows) {
    const primary = `sc-domain:${domain}`;
    try {
        const rows = await queryDaily(sc, primary, windows.prevStart, windows.end);
        return { rows, siteUrl: primary };
    } catch (err) {
        if (gscErrorStatus(err) !== 403) throw err;
    }
    const fallback = `https://${domain}/`;
    const rows = await queryDaily(sc, fallback, windows.prevStart, windows.end);
    return { rows, siteUrl: fallback };
}

function buildGscRecord({ rows, siteUrl, windows, checkedAt, error }) {
    if (error) {
        return {
            siteUrl: siteUrl || null,
            start: windows.start,
            end: windows.end,
            prev_start: windows.prevStart,
            prev_end: windows.prevEnd,
            clicks: null,
            impressions: null,
            ctr: null,
            position: null,
            prev_clicks: null,
            prev_impressions: null,
            prev_ctr: null,
            prev_position: null,
            checked_at: checkedAt,
            error,
        };
    }
    const current = sumWindow(rows, windows.start, windows.end);
    const prev = sumWindow(rows, windows.prevStart, windows.prevEnd);
    return {
        siteUrl,
        start: windows.start,
        end: windows.end,
        prev_start: windows.prevStart,
        prev_end: windows.prevEnd,
        clicks: current.clicks,
        impressions: current.impressions,
        ctr: current.ctr,
        position: current.position,
        prev_clicks: prev.clicks,
        prev_impressions: prev.impressions,
        prev_ctr: prev.ctr,
        prev_position: prev.position,
        checked_at: checkedAt,
        error: null,
    };
}

async function runPool(items, concurrency, worker) {
    let next = 0;
    const n = Math.max(1, Math.min(concurrency, items.length || 1));
    await Promise.all(
        Array.from({ length: n }, async () => {
            while (next < items.length) {
                const i = next;
                next += 1;
                await worker(items[i], i);
            }
        }),
    );
}

async function runGsc(options = {}) {
    const env = options.env || process.env;
    const secrets = loadSecretsFromEnv(env);
    if (!secrets || !secrets.tokens.size) {
        console.log("GSC не настроен — пропускаем динамику");
        return { skipped: true };
    }

    const sitesPath = options.sitesPath || SITES_PATH;
    const csvPath = options.csvPath || CSV_PATH;
    const statusPath = options.statusPath || STATUS_PATH;
    const sites = JSON.parse(fs.readFileSync(sitesPath, "utf8"));
    const catalog = loadCatalogByDomain(fs.readFileSync(csvPath, "utf8"));
    const prevStatus = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    const windows = options.windows || gscWindows(options.now ? new Date(options.now) : new Date());
    const checkedAt = options.checkedAt || new Date().toISOString();
    const getClient = options.getClient || clientCache(secrets.client);
    const queryFn = options.queryFn;

    const prevByHost = new Map();
    for (const row of prevStatus.data || []) {
        const host = hostFromSiteUrl(row.url);
        if (host && row.gsc && !prevByHost.has(host)) prevByHost.set(host, row.gsc);
    }

    const jobs = [];
    let skipped = 0;
    for (const item of uniqueMonitoredHosts(sites)) {
        const catalogRow = catalog.get(item.host);
        const account = String(catalogRow?.account || "")
            .trim()
            .toLowerCase();
        const token = secrets.tokens.get(account);
        if (!account || !token) {
            skipped += 1;
            continue;
        }
        jobs.push({ host: item.host, account, token });
    }

    const byHost = new Map();
    let failed = 0;
    await runPool(jobs, options.concurrency || 6, async (job) => {
        try {
            let rows;
            let siteUrl;
            if (queryFn) {
                const result = await queryFn(job.host, windows);
                rows = result.rows;
                siteUrl = result.siteUrl;
            } else {
                const { sc } = getClient(job.account, job.token);
                const result = await queryWithFallback(sc, job.host, windows);
                rows = result.rows;
                siteUrl = result.siteUrl;
            }
            byHost.set(
                job.host,
                buildGscRecord({ rows, siteUrl, windows, checkedAt, error: null }),
            );
        } catch (err) {
            failed += 1;
            const prev = prevByHost.get(job.host);
            const message = gscErrorMessage(err);
            if (prev && prev.error == null && prev.impressions != null) {
                byHost.set(job.host, {
                    ...prev,
                    checked_at: checkedAt,
                    error: message,
                    stale: true,
                });
            } else {
                byHost.set(
                    job.host,
                    buildGscRecord({
                        rows: [],
                        siteUrl: null,
                        windows,
                        checkedAt,
                        error: message,
                    }),
                );
            }
            console.error(`GSC ${job.host}: ${message}`);
        }
    });

    const nextData = (prevStatus.data || []).map((row) => {
        const host = hostFromSiteUrl(row.url);
        if (host && byHost.has(host)) return { ...row, gsc: byHost.get(host) };
        return { ...row, gsc: row.gsc ?? null };
    });

    const statusData = {
        ...prevStatus,
        gsc_last_update: checkedAt,
        data: nextData,
    };
    if (options.write !== false) {
        fs.writeFileSync(statusPath, JSON.stringify(statusData, null, 2));
    }
    console.log(
        `GSC: sites=${jobs.length} failed=${failed} skipped=${skipped} ${windows.start}..${windows.end} vs ${windows.prevStart}..${windows.prevEnd}`,
    );
    return { skipped: false, jobs: jobs.length, failed, skippedHosts: skipped, windows, statusData };
}

module.exports = {
    addDays,
    gscWindows,
    sumWindow,
    buildGscRecord,
    runGsc,
};

if (require.main === module) {
    loadLocalEnv();
    runGsc().catch((err) => {
        console.error("GSC-динамика упала:", err);
        process.exit(1);
    });
}
