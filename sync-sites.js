const fs = require("fs");
const { parseCsv, hostFromSiteUrl } = require("./seo");

const SITES_JSON = "./sites.json";
const SITES_CSV = "./sites.csv";
const DROPS_CSV = "./drops.csv";

function hostKey(domain) {
    return String(domain || "")
        .trim()
        .toLowerCase()
        .replace(/^www\./, "")
        .replace(/\.$/, "");
}

function nsFromRow(row) {
    const seen = new Set();
    const out = [];
    for (const raw of [row?.ns1, row?.ns2]) {
        const name = String(raw || "")
            .trim()
            .toLowerCase()
            .replace(/\.$/, "");
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push(name);
    }
    return out;
}

function hasAccount(row) {
    return Boolean(String(row?.account || "").trim());
}

function isBetterRow(next, prev) {
    const nextAcc = hasAccount(next);
    const prevAcc = hasAccount(prev);
    if (nextAcc !== prevAcc) return nextAcc;
    return nsFromRow(next).length > nsFromRow(prev).length;
}

function collectCsvHosts(sitesCsvText, dropsCsvText) {
    const map = new Map();
    const order = [];
    for (const text of [sitesCsvText, dropsCsvText]) {
        for (const row of parseCsv(text)) {
            const host = hostKey(row.domain);
            if (!host) continue;
            const prev = map.get(host);
            if (!prev) {
                map.set(host, row);
                order.push(host);
                continue;
            }
            if (isBetterRow(row, prev)) map.set(host, row);
        }
    }
    return { map, order };
}

function siteFromRow(host, row) {
    const site = { url: `https://${host}` };
    const ns = nsFromRow(row);
    if (ns.length) site.ns = ns;
    return site;
}

/** CSV — кто в мониторе. Старый порядок sites.json сохраняется, новые хосты в конец. */
function syncMonitorList(existing, sitesCsvText, dropsCsvText) {
    const { map, order } = collectCsvHosts(sitesCsvText, dropsCsvText);
    const seen = new Set();
    const out = [];
    for (const item of existing || []) {
        const host = hostFromSiteUrl(item.url) || hostKey(item.url);
        if (!host || seen.has(host) || !map.has(host)) continue;
        seen.add(host);
        out.push(siteFromRow(host, map.get(host)));
    }
    for (const host of order) {
        if (seen.has(host)) continue;
        seen.add(host);
        out.push(siteFromRow(host, map.get(host)));
    }
    return out;
}

function formatSitesJson(sites) {
    return `${JSON.stringify(sites, null, 4)}\n`;
}

function syncSitesFiles({
    sitesJsonPath = SITES_JSON,
    sitesCsvPath = SITES_CSV,
    dropsCsvPath = DROPS_CSV,
} = {}) {
    const existing = JSON.parse(fs.readFileSync(sitesJsonPath, "utf8"));
    const next = syncMonitorList(
        existing,
        fs.readFileSync(sitesCsvPath, "utf8"),
        fs.readFileSync(dropsCsvPath, "utf8"),
    );
    fs.writeFileSync(sitesJsonPath, formatSitesJson(next));
    return {
        before: existing.length,
        after: next.length,
        added: next
            .map((site) => hostFromSiteUrl(site.url))
            .filter(
                (host) =>
                    !existing.some(
                        (item) => hostFromSiteUrl(item.url) === host,
                    ),
            ),
    };
}

if (require.main === module) {
    const result = syncSitesFiles();
    console.log(
        `sites.json ${result.before} → ${result.after} (+${result.added.length})`,
    );
    if (result.added.length) {
        console.log(result.added.map((host) => `  ${host}`).join("\n"));
    }
}

module.exports = {
    hostKey,
    nsFromRow,
    collectCsvHosts,
    syncMonitorList,
    formatSitesJson,
    syncSitesFiles,
};
