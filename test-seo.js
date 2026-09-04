const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { spawnSync } = require("child_process");
const {
    parseCsv,
    loadCatalogByDomain,
    hostFromSiteUrl,
    pageUrlForSlot,
    pageTargetsForRow,
    parseSitemapXml,
    sitemapPageUrls,
    sitemapTargets,
    slotFromUrl,
    mergePageRecord,
    hasSitemapIndex,
    upsertPages,
    uniqueMonitoredHosts,
    parseClientSecretJson,
    parseAccountsJson,
    loadSecretsFromEnv,
    isIndexed,
    createQuota,
    buildHostIndex,
    buildSeoDiff,
    hasPriorIndex,
    formatSeoMessage,
    formatAuthFailMessage,
    formatRetryNotice,
    formatIndexedUrl,
    shouldRetrySeo,
    applyIndexToStatusData,
    inspectUrlWithFallback,
    inspectHttpError,
    withTimeout,
    runSeo,
} = require("./seo");

let failed = 0;
function test(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`ok  ${name}`))
        .catch((err) => {
            failed += 1;
            console.error(`FAIL ${name}`);
            console.error(err);
        });
}

function passJson() {
    return {
        inspectionResult: {
            indexStatusResult: {
                verdict: "PASS",
                coverageState: "Submitted and indexed",
                lastCrawlTime: "2026-09-01T00:00:00Z",
            },
        },
    };
}

function failJson() {
    return {
        inspectionResult: {
            indexStatusResult: {
                verdict: "NEUTRAL",
                coverageState: "Crawled - currently not indexed",
            },
        },
    };
}

async function main() {
    await test("csv: bet-rino.co.uk берёт строку с account", () => {
        const csv = fs.readFileSync("./sites.csv", "utf8");
        const catalog = loadCatalogByDomain(csv);
        const row = catalog.get("bet-rino.co.uk");
        assert.ok(row, "нет bet-rino.co.uk");
        assert.equal(row.group, "uk-betrino");
        assert.equal(row.account.trim().toLowerCase(), "frolovserg59@gmail.com");
    });

    await test("csv: все money-домены с account, дублей с пустым account нет", () => {
        const csv = fs.readFileSync("./sites.csv", "utf8");
        const rows = parseCsv(csv).filter((r) => String(r.domain || "").trim());
        const catalog = loadCatalogByDomain(csv);
        assert.ok(catalog.size >= 430, `доменов ${catalog.size}`);
        for (const [domain, row] of catalog) {
            assert.ok(
                String(row.account || "").trim(),
                `пустой account у ${domain}`,
            );
        }
        const emptyAccountRows = rows.filter(
            (r) =>
                String(r.domain || "").trim() && !String(r.account || "").trim(),
        );
        for (const row of emptyAccountRows) {
            const chosen = catalog.get(row.domain.trim().toLowerCase());
            assert.ok(
                String(chosen.account || "").trim(),
                `дубль ${row.domain} не получил account`,
            );
        }
    });

    await test("не фильтруем по enabled: в каталог попадают и false", () => {
        const csv = fs.readFileSync("./sites.csv", "utf8");
        const rows = parseCsv(csv).filter((r) => String(r.domain || "").trim());
        const catalog = loadCatalogByDomain(csv);
        const falseRows = rows.filter(
            (r) => String(r.enabled).trim().toLowerCase() === "false",
        );
        assert.ok(falseRows.length > 0);
        assert.ok(catalog.size > 400);
        assert.ok(
            catalog.has(falseRows[0].domain.trim().toLowerCase()),
            "enabled=false должен быть в каталоге",
        );
    });

    await test("URL слотов: home → /, login → /login/, минус пропускается", () => {
        assert.equal(pageUrlForSlot("example.com", "home"), "https://example.com/");
        assert.equal(pageUrlForSlot("example.com", "login"), "https://example.com/login/");
        const pages = pageTargetsForRow("example.com", {
            pages: "home|login|-bonus|register",
        });
        assert.deepEqual(
            pages.map((p) => p.slot),
            ["home", "login", "register"],
        );
        assert.equal(pages[0].url, "https://example.com/");
        assert.equal(pages[2].url, "https://example.com/register/");
        assert.ok(!pages.some((p) => p.slot === "bonus"));
    });

    await test("очередь = CSV-слоты: sitemap только резолвит путь, legal-URL не попадают", () => {
        const host = "new-vegas-casino.gb.net";
        const catalogRow = {
            pages: "home|login|app|register|games|bet|bonus|deposit",
        };
        const sitemap = [
            "https://new-vegas-casino.gb.net/about-us/",
            "https://new-vegas-casino.gb.net/mobile-application/",
            "https://new-vegas-casino.gb.net/bet/",
            "https://new-vegas-casino.gb.net/bonuses/",
            "https://new-vegas-casino.gb.net/contact-us/",
            "https://new-vegas-casino.gb.net/deposit/",
            "https://new-vegas-casino.gb.net/slots-games/",
            "https://new-vegas-casino.gb.net/login/",
            "https://new-vegas-casino.gb.net/privacy-policy/",
            "https://new-vegas-casino.gb.net/registration/",
            "https://new-vegas-casino.gb.net/safe-gambling/",
            "https://new-vegas-casino.gb.net/terms-of-service/",
            "https://new-vegas-casino.gb.net/en-gb/bonuses/",
        ];
        const pages = pageTargetsForRow(host, catalogRow, sitemap);
        assert.deepEqual(
            pages.map((p) => p.slot),
            ["home", "login", "app", "register", "games", "bet", "bonus", "deposit"],
        );
        const bySlot = Object.fromEntries(pages.map((p) => [p.slot, p.url]));
        assert.equal(bySlot.home, "https://new-vegas-casino.gb.net/");
        assert.equal(bySlot.login, "https://new-vegas-casino.gb.net/login/");
        assert.equal(bySlot.app, "https://new-vegas-casino.gb.net/mobile-application/");
        assert.equal(bySlot.register, "https://new-vegas-casino.gb.net/registration/");
        assert.equal(bySlot.games, "https://new-vegas-casino.gb.net/slots-games/");
        assert.equal(bySlot.bet, "https://new-vegas-casino.gb.net/bet/");
        assert.equal(bySlot.bonus, "https://new-vegas-casino.gb.net/bonuses/");
        assert.equal(bySlot.deposit, "https://new-vegas-casino.gb.net/deposit/");
        assert.ok(
            !pages.some((p) =>
                /contact-us|privacy-policy|terms-of-service|about-us/.test(p.url),
            ),
        );
        assert.ok(!pages.some((p) => p.slot === "bonuses" || p.slot === "slots-games"));
        assert.equal(
            pageTargetsForRow(host, catalogRow, [
                "https://new-vegas-casino.gb.net/accedi/",
            ]).find((p) => p.slot === "login").url,
            "https://new-vegas-casino.gb.net/accedi/",
        );
        const stored = sitemapPageUrls(host, sitemap);
        assert.ok(stored.includes("https://new-vegas-casino.gb.net/contact-us/"));
        assert.ok(stored.length > pages.length - 1);
    });

    await test("уникальные хосты из sites.json и skip без CSV", () => {
        const sites = JSON.parse(fs.readFileSync("./sites.json", "utf8"));
        const hosts = uniqueMonitoredHosts(sites);
        const catalog = loadCatalogByDomain(fs.readFileSync("./sites.csv", "utf8"));
        const uniqueUrls = new Set(sites.map((s) => s.url));
        assert.equal(hosts.length, uniqueUrls.size);
        const missing = hosts.filter((h) => !catalog.has(h.host));
        assert.ok(missing.length >= 1, "ожидали drop-домены без CSV");
        assert.ok(missing.some((h) => h.host === "airnaturel.co.uk"));
    });

    await test("OAuth web + accounts.json мета-ключи", () => {
        const client = parseClientSecretJson(
            JSON.stringify({
                web: { client_id: "abc.apps.googleusercontent.com", client_secret: "s" },
            }),
        );
        assert.equal(client.client_id, "abc.apps.googleusercontent.com");
        const tokens = parseAccountsJson(
            JSON.stringify({
                description: "meta",
                clientSecretsFile: "data/gsc/x.json",
                "FrolovSerg59@gmail.com": { refreshToken: "1//aaa" },
            }),
        );
        assert.equal(tokens.size, 1);
        assert.equal(tokens.get("frolovserg59@gmail.com"), "1//aaa");
        assert.equal(
            loadSecretsFromEnv({}),
            null,
        );
        assert.equal(
            loadSecretsFromEnv({ GSC_CLIENT_SECRET_JSON: "{}" }),
            null,
        );
    });

    await test("isIndexed: PASS / not indexed / Indexed", () => {
        assert.equal(isIndexed({ verdict: "PASS" }), true);
        assert.equal(
            isIndexed({ coverageState: "Crawled - currently not indexed" }),
            false,
        );
        assert.equal(
            isIndexed({ coverageState: "Submitted and indexed" }),
            true,
        );
        assert.equal(isIndexed(null), false);
    });

    await test("fallback siteUrl на 403", async () => {
        const calls = [];
        const quota = createQuota(5);
        const inspectFn = async (inspectionUrl, siteUrl) => {
            calls.push({ inspectionUrl, siteUrl });
            if (siteUrl.startsWith("sc-domain:")) {
                return { ok: false, status: 403, json: null, error: "forbidden" };
            }
            return { ok: true, status: 200, json: passJson(), error: null };
        };
        const result = await inspectUrlWithFallback(
            inspectFn,
            "https://example.com/",
            "example.com",
            quota,
        );
        assert.equal(result.usedFallback, true);
        assert.equal(result.siteUrl, "https://example.com/");
        assert.equal(result.ok, true);
        assert.equal(calls.length, 2);
        assert.equal(quota.used, 2);
    });

    await test("квота не уходит ниже нуля", () => {
        const quota = createQuota(1);
        assert.equal(quota.take(), true);
        assert.equal(quota.take(), false);
        assert.equal(quota.remaining(), 0);
        assert.equal(quota.used, 1);
    });

    await test("дифф: выпало / попало, первый прогон — база", () => {
        assert.equal(hasPriorIndex({ data: [] }), false);
        assert.equal(
            hasPriorIndex({
                index_last_update: "2026-09-01T00:00:00Z",
                data: [
                    {
                        url: "https://a.com",
                        index: { pages: [], error: "GSC auth failed" },
                    },
                ],
            }),
            false,
        );
        const prev = {
            index_last_update: "2026-09-01T00:00:00Z",
            data: [
                {
                    url: "https://a.com",
                    index: {
                        pages: [
                            { url: "https://a.com/", indexed: true },
                            { url: "https://a.com/login", indexed: false },
                        ],
                    },
                },
            ],
        };
        const next = new Map([
            [
                "a.com",
                {
                    pages: [
                        { url: "https://a.com/", indexed: false },
                        { url: "https://a.com/login", indexed: true },
                    ],
                },
            ],
        ]);
        const diff = buildSeoDiff(prev, next);
        assert.deepEqual(diff.dropped, ["https://a.com/"]);
        assert.deepEqual(diff.recovered, ["https://a.com/login"]);
        const baseline = formatSeoMessage({
            isBaseline: true,
            diff,
            stats: {
                homesChecked: 10,
                homesIndexed: 2,
                homesNotIndexed: 7,
                homesErrors: 1,
                pagesCheckedToday: 15,
                pagesIndexed: 2,
                innerChecked: 5,
                innerIndexed: 0,
                innerTotal: 20,
                skipped: 7,
                eligible: 10,
            },
        });
        assert.ok(baseline.includes("Индексация Google"));
        assert.ok(baseline.includes("Главные"));
        assert.ok(baseline.includes("Внутренние"));
        assert.ok(baseline.includes("страницы из sites.csv"));
        assert.ok(!baseline.includes("адреса из sitemap"));
        assert.ok(baseline.includes("проверено: 10 из 10"));
        assert.ok(baseline.includes("не в индексе: 7"));
        assert.ok(!baseline.includes("накоплено"));
        assert.ok(!baseline.includes("база записана"));
        const authFail = formatAuthFailMessage({
            eligible: 433,
            skipped: 7,
            detail: "invalid_client",
        });
        assert.ok(authFail.includes("проверка не началась"));
        assert.ok(!authFail.includes("база записана"));
        const change = formatSeoMessage({
            isBaseline: false,
            diff,
            stats: {},
        });
        assert.ok(change.includes("Выпали из индекса"));
        assert.ok(change.includes("Появились в индексе"));
        assert.ok(change.includes("a.com/ — главная"));
        assert.ok(change.includes("a.com/login"));
        assert.equal(
            formatSeoMessage({
                isBaseline: false,
                diff: { dropped: [], recovered: [], errors: [] },
                stats: {},
            }),
            null,
        );
        assert.equal(formatIndexedUrl("https://a.com/"), "a.com/ — главная");
        assert.equal(formatIndexedUrl("https://www.a.com/login"), "a.com/login");
        assert.equal(shouldRetrySeo({ skipped: true }), false);
        assert.equal(shouldRetrySeo({ stalled: true, stats: { stalledReason: "inspect" } }), true);
        assert.equal(
            shouldRetrySeo({
                stalled: true,
                stats: { stalledReason: "auth", authDetail: "invalid_client" },
            }),
            false,
        );
        assert.equal(
            shouldRetrySeo({
                stalled: true,
                stats: { stalledReason: "auth", authDetail: "GSC auth timeout" },
            }),
            true,
        );
        assert.ok(formatRetryNotice().includes("ещё раз"));
    });

    await test("аптайм не затирает index: merge в status.data", () => {
        const index = { indexed: true, pages: [{ url: "https://a.com/", indexed: true }] };
        const data = applyIndexToStatusData(
            [
                { url: "https://a.com", status: 503, alive: true },
                { url: "https://skip.com", status: 200, alive: true, index: null },
            ],
            new Map([["a.com", index]]),
        );
        assert.equal(data[0].status, 503);
        assert.equal(data[0].index.indexed, true);
        assert.equal(data[1].index, null);
    });

    await test("buildHostIndex копит внутренние страницы между днями", () => {
        const host = "a.com";
        const catalogRow = { pages: "home|login|bonus" };
        const day1 = buildHostIndex({
            host,
            catalogRow,
            prevIndex: null,
            updates: [
                {
                    url: "https://a.com/",
                    slot: "home",
                    indexed: true,
                    checked_at: "t1",
                    error: null,
                },
            ],
            siteUrl: "sc-domain:a.com",
            checkedAt: "t1",
        });
        assert.equal(day1.indexed, true);
        assert.equal(day1.pages_total, 3);
        assert.equal(day1.pages.length, 1);
        const day2 = buildHostIndex({
            host,
            catalogRow,
            prevIndex: day1,
            updates: [
                {
                    url: "https://a.com/login/",
                    slot: "login",
                    indexed: false,
                    checked_at: "t2",
                    error: null,
                },
            ],
            siteUrl: "sc-domain:a.com",
            checkedAt: "t2",
        });
        assert.equal(day2.pages.length, 2);
        assert.equal(day2.pages_checked, 2);
        assert.ok(day2.pages.some((p) => p.slot === "home" && p.indexed === true));
        assert.ok(day2.pages.some((p) => p.slot === "login" && p.indexed === false));
    });

    await test("buildHostIndex: CSV-слоты, slot=bonus не bonuses, legal-URL вычищаются", () => {
        const host = "new-vegas-casino.gb.net";
        const catalogRow = {
            pages: "home|login|app|register|games|bet|bonus|deposit",
        };
        const sitemap = [
            "https://new-vegas-casino.gb.net/mobile-application/",
            "https://new-vegas-casino.gb.net/bet/",
            "https://new-vegas-casino.gb.net/bonuses/",
            "https://new-vegas-casino.gb.net/contact-us/",
            "https://new-vegas-casino.gb.net/deposit/",
            "https://new-vegas-casino.gb.net/slots-games/",
            "https://new-vegas-casino.gb.net/login/",
            "https://new-vegas-casino.gb.net/privacy-policy/",
            "https://new-vegas-casino.gb.net/registration/",
        ];
        const targets = pageTargetsForRow(host, catalogRow, sitemap);
        const prevIndex = {
            pages: [
                {
                    url: "https://new-vegas-casino.gb.net/",
                    slot: "home",
                    indexed: true,
                    checked_at: "t1",
                    error: null,
                },
                {
                    url: "https://new-vegas-casino.gb.net/bonuses/",
                    slot: "bonuses",
                    indexed: true,
                    checked_at: "t1",
                    error: null,
                },
                {
                    url: "https://new-vegas-casino.gb.net/contact-us/",
                    slot: "contact-us",
                    indexed: false,
                    checked_at: "t1",
                    error: null,
                },
                {
                    url: "https://new-vegas-casino.gb.net/privacy-policy/",
                    slot: "privacy-policy",
                    indexed: false,
                    checked_at: "t1",
                    error: null,
                },
            ],
        };
        const next = buildHostIndex({
            host,
            catalogRow,
            targets,
            prevIndex,
            updates: [],
            siteUrl: `sc-domain:${host}`,
            checkedAt: "t2",
        });
        assert.equal(next.pages_total, 8);
        assert.ok(!next.pages.some((p) => p.slot === "contact-us" || p.slot === "privacy-policy"));
        assert.ok(!next.pages.some((p) => p.slot === "bonuses"));
        const bonus = next.pages.find((p) => p.slot === "bonus");
        assert.ok(bonus);
        assert.equal(bonus.url, "https://new-vegas-casino.gb.net/bonuses/");
        assert.equal(bonus.indexed, true);
        assert.equal(next.pages_checked, 2);
        assert.equal(next.pages_indexed, 2);
    });

    await test("runSeo mock: главные каждый день, внутренние по квоте", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-test-"));
        const sitesPath = path.join(dir, "sites.json");
        const csvPath = path.join(dir, "sites.csv");
        const statusPath = path.join(dir, "status.json");
        fs.writeFileSync(
            sitesPath,
            JSON.stringify([
                { url: "https://alpha.test" },
                { url: "https://beta.test" },
            ]),
        );
        fs.writeFileSync(
            csvPath,
            [
                "enabled,group,domain,pages,account",
                "false,g,alpha.test,home|login|bonus,one@gmail.com",
                "false,g,beta.test,home|login|bonus,one@gmail.com",
            ].join("\n"),
        );
        fs.writeFileSync(
            statusPath,
            JSON.stringify({
                last_update: "2026-09-01T00:00:00Z",
                data: [
                    { url: "https://alpha.test", status: 503, alive: true },
                    { url: "https://beta.test", status: 200, alive: true },
                ],
            }),
        );

        const calls = [];
        const inspectFn = async (inspectionUrl, siteUrl) => {
            calls.push({ inspectionUrl, siteUrl });
            const indexed =
                new URL(inspectionUrl).pathname === "/" || inspectionUrl.includes("/login/");
            return {
                ok: true,
                status: 200,
                json: indexed ? passJson() : failJson(),
                error: null,
            };
        };
        const sitemapFn = async (host) => ({
            urls: [
                `https://${host}/`,
                `https://${host}/login/`,
                `https://${host}/bonuses/`,
                `https://${host}/contact-us/`,
                `https://${host}/privacy-policy/`,
            ],
            error: null,
        });
        const env = {
            GSC_CLIENT_SECRET_JSON: JSON.stringify({
                web: { client_id: "id", client_secret: "secret" },
            }),
            GSC_ACCOUNTS_JSON: JSON.stringify({
                "one@gmail.com": { refreshToken: "1//x" },
            }),
        };

        const day1 = await runSeo({
            env,
            inspectFn,
            sitemapFn,
            quotaLimit: 3,
            sitesPath,
            csvPath,
            statusPath,
        });
        assert.equal(day1.skipped, false);
        assert.equal(day1.isBaseline, true);
        assert.equal(day1.stats.homesChecked, 2);
        assert.equal(day1.stats.pagesCheckedToday, 3);
        assert.equal(day1.stats.sitemapLive, 2);
        assert.equal(day1.stats.innerTotal, 4);
        assert.equal(calls.length, 3);
        assert.ok(calls.every((c) => c.siteUrl.startsWith("sc-domain:")));

        const after1 = JSON.parse(fs.readFileSync(statusPath, "utf8"));
        assert.equal(after1.last_update, "2026-09-01T00:00:00Z");
        assert.ok(after1.index_last_update);
        assert.equal(after1.data[0].status, 503);
        assert.equal(after1.data[0].index.indexed, true);
        assert.ok(after1.data[0].index.pages.some((p) => p.slot === "home"));
        assert.equal(after1.data[0].index.sitemap.source, "live");
        assert.deepEqual(after1.data[0].index.sitemap.urls, [
            "https://alpha.test/login/",
            "https://alpha.test/bonuses/",
            "https://alpha.test/contact-us/",
            "https://alpha.test/privacy-policy/",
        ]);
        assert.ok(
            !after1.data[0].index.pages.some((p) =>
                /contact-us|privacy-policy/.test(p.url || p.slot),
            ),
        );
        assert.equal(after1.data[0].index.pages_total, 3);

        const day2 = await runSeo({
            env,
            inspectFn,
            sitemapFn,
            quotaLimit: 3,
            sitesPath,
            csvPath,
            statusPath,
        });
        assert.equal(day2.isBaseline, false);
        assert.equal(day2.stats.homesChecked, 2);
        const after2 = JSON.parse(fs.readFileSync(statusPath, "utf8"));
        const pages = after2.data[0].index.pages.concat(after2.data[1].index.pages);
        const slots = new Set(pages.map((p) => `${hostFromSiteUrl(p.url)}:${p.slot}`));
        assert.ok(slots.has("alpha.test:home"));
        assert.ok(slots.has("beta.test:home"));
        assert.ok(
            [...slots].some((s) => s.endsWith(":login") || s.endsWith(":bonus")),
            "внутренние страницы должны появиться за 2 дня",
        );
        assert.ok(
            pages.every((p) => p.slot === "home" || p.url.endsWith("/")),
            "URL внутренних берутся из sitemap как есть",
        );
        assert.ok(
            pages.every((p) => p.slot !== "bonuses" && p.slot !== "contact-us"),
            "slot — имя из CSV, не путь sitemap",
        );
        assert.ok(!calls.some((c) => /contact-us|privacy-policy/.test(c.inspectionUrl)));

        // День 3: sitemap недоступен — берём список из кэша status.json
        const day3 = await runSeo({
            env,
            inspectFn,
            sitemapFn: async () => ({ urls: [], error: "sitemap timeout" }),
            quotaLimit: 3,
            sitesPath,
            csvPath,
            statusPath,
        });
        assert.equal(day3.stats.sitemapCached, 2);
        assert.equal(day3.stats.innerTotal, 4);
        const after3 = JSON.parse(fs.readFileSync(statusPath, "utf8"));
        assert.equal(after3.data[0].index.sitemap.source, "cache");
        assert.equal(after3.data[0].index.sitemap.urls.length, 4);

        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test("runSeo: старая база без sitemap → сводка один раз, мусорные URL вычищаются", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seo-test-"));
        const sitesPath = path.join(dir, "sites.json");
        const csvPath = path.join(dir, "sites.csv");
        const statusPath = path.join(dir, "status.json");
        fs.writeFileSync(sitesPath, JSON.stringify([{ url: "https://alpha.test" }]));
        fs.writeFileSync(
            csvPath,
            ["enabled,group,domain,pages,account", "false,g,alpha.test,home|login,one@gmail.com"].join(
                "\n",
            ),
        );
        fs.writeFileSync(
            statusPath,
            JSON.stringify({
                data: [
                    {
                        url: "https://alpha.test",
                        index: {
                            indexed: true,
                            pages: [
                                { url: "https://alpha.test/", slot: "home", indexed: true, error: null },
                                { url: "https://alpha.test/login", slot: "login", indexed: null, error: "INTERNAL" },
                            ],
                        },
                    },
                ],
            }),
        );
        const env = {
            GSC_CLIENT_SECRET_JSON: JSON.stringify({ web: { client_id: "id", client_secret: "s" } }),
            GSC_ACCOUNTS_JSON: JSON.stringify({ "one@gmail.com": { refreshToken: "1//x" } }),
        };
        const result = await runSeo({
            env,
            inspectFn: async () => ({ ok: true, status: 200, json: passJson(), error: null }),
            sitemapFn: async () => ({ urls: ["https://alpha.test/accedi/"], error: null }),
            quotaLimit: 10,
            sitesPath,
            csvPath,
            statusPath,
        });
        assert.equal(result.isBaseline, true, "после перехода на sitemap сводка шлётся снова");
        const after = JSON.parse(fs.readFileSync(statusPath, "utf8"));
        const pageRows = after.data[0].index.pages;
        assert.deepEqual(
            pageRows.map((p) => p.slot).sort(),
            ["home", "login"],
        );
        assert.deepEqual(
            pageRows.map((p) => p.url).sort(),
            ["https://alpha.test/", "https://alpha.test/accedi/"],
        );
        assert.equal(
            pageRows.find((p) => p.slot === "login").url,
            "https://alpha.test/accedi/",
        );
        assert.equal(after.data[0].index.pages_total, 2);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test("parseSitemapXml: urlset, sitemapindex, CDATA, entities", () => {
        const urlset = `<?xml version="1.0"?><urlset><url><loc>https://a.com/</loc></url>
            <url><loc><![CDATA[https://a.com/x/]]></loc></url>
            <url><loc>https://a.com/q?a=1&amp;b=2</loc></url></urlset>`;
        assert.deepEqual(parseSitemapXml(urlset), {
            urls: ["https://a.com/", "https://a.com/x/", "https://a.com/q?a=1&b=2"],
            sitemaps: [],
        });
        const index = `<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>`;
        assert.deepEqual(parseSitemapXml(index), { urls: [], sitemaps: ["https://a.com/s1.xml"] });
        assert.deepEqual(parseSitemapXml("<html>not a sitemap</html>"), { urls: [], sitemaps: [] });
    });

    await test("sitemapTargets: главная всегда первая, чужие хосты/visit/файлы отбрасываются", () => {
        const targets = sitemapTargets("a.com", [
            "https://www.a.com/",
            "https://a.com/login/",
            "https://a.com/login/",
            "https://other.com/login/",
            "https://a.com/visit/",
            "https://a.com/visit/bonus",
            "https://a.com/sitemap-2.xml",
            "https://a.com/img/logo.png",
            "http://a.com/bonus",
            "garbage",
        ]);
        assert.deepEqual(targets, [
            { slot: "home", url: "https://a.com/" },
            { slot: "login", url: "https://a.com/login/" },
            { slot: "bonus", url: "https://a.com/bonus" },
        ]);
        const many = sitemapTargets(
            "a.com",
            Array.from({ length: 100 }, (_, i) => `https://a.com/p${i}/`),
            5,
        );
        assert.equal(many.length, 6);
        assert.equal(slotFromUrl("https://a.com/metodi-di-pagamento/"), "metodi-di-pagamento");
        assert.equal(slotFromUrl("https://a.com/"), "home");
    });

    await test("ошибка Google не затирает прошлый статус страницы", () => {
        const prev = {
            url: "https://a.com/",
            slot: "home",
            indexed: true,
            coverageState: "Submitted and indexed",
            checked_at: "t1",
            error: null,
        };
        const errored = {
            url: "https://a.com/",
            slot: "home",
            indexed: null,
            coverageState: null,
            checked_at: "t2",
            error: "INTERNAL: boom",
        };
        const merged = mergePageRecord(prev, errored);
        assert.equal(merged.indexed, true);
        assert.equal(merged.coverageState, "Submitted and indexed");
        assert.equal(merged.error, "INTERNAL: boom");
        assert.equal(merged.stale, true);
        assert.equal(merged.status_from, "t1");
        assert.equal(merged.checked_at, "t2");

        // ошибка поверх ошибки — статуса не было, ничего не выдумываем
        assert.equal(mergePageRecord(errored, { ...errored, checked_at: "t3" }).indexed, null);
        // нормальный ответ поверх ошибки — берём новое
        const fresh = { ...prev, indexed: false, checked_at: "t3" };
        assert.equal(mergePageRecord(errored, fresh).indexed, false);
        assert.equal(mergePageRecord(errored, fresh).stale, undefined);

        const pages = upsertPages([prev], [errored]);
        assert.equal(pages.length, 1);
        assert.equal(pages[0].indexed, true);

        // диф: день 1 indexed, день 2 ошибка (статус сохранён), день 3 реально выпала → dropped
        const day2 = new Map([["a.com", { pages }]]);
        const prevStatus = { data: [{ url: "https://a.com", index: { pages } }] };
        const day3 = new Map([
            ["a.com", { pages: [{ ...prev, indexed: false, coverageState: "Crawled - currently not indexed", checked_at: "t3" }] }],
        ]);
        const diff2 = buildSeoDiff({ data: [{ url: "https://a.com", index: { pages: [prev] } }] }, day2);
        assert.deepEqual(diff2.dropped, []);
        assert.deepEqual(diff2.errors, ["https://a.com/"]);
        const diff3 = buildSeoDiff(prevStatus, day3);
        assert.deepEqual(diff3.dropped, ["https://a.com/"]);
        assert.equal(diff3.reasons["https://a.com/"], "Crawled - currently not indexed");
    });

    await test("hasSitemapIndex + noindex в сводке", () => {
        assert.equal(hasSitemapIndex({ data: [{ index: { pages: [] } }] }), false);
        assert.equal(hasSitemapIndex({ data: [{ index: { sitemap: { urls: [] } } }] }), true);
        const msg = formatSeoMessage({
            isBaseline: true,
            diff: { dropped: ["https://a.com/"], recovered: [], errors: [], reasons: { "https://a.com/": "Excluded by 'noindex' tag" } },
            stats: {
                homesChecked: 10,
                eligible: 10,
                homesIndexed: 7,
                homesNotIndexed: 3,
                homesNoindex: 2,
                homesErrors: 1,
                innerChecked: 5,
                innerIndexed: 4,
                innerNotIndexed: 1,
                innerTotal: 12,
                sitemapMissing: 1,
                skipped: 0,
            },
        });
        assert.ok(msg.includes("noindex (сайт сам запрещает): 2"));
        assert.ok(msg.includes("остальные (7) — в следующие дни"));
        assert.ok(msg.includes("без sitemap.xml (пути по имени слота): 1"));
        assert.ok(msg.includes("Выпали из индекса (1)"));
        assert.ok(msg.includes("a.com/ — главная (Excluded by 'noindex' tag)"));
    });

    await test("runSeo без секретов — skip, status.json не трогает", async () => {
        const before = fs.readFileSync("./status.json", "utf8");
        const result = await runSeo({ env: {} });
        assert.equal(result.skipped, true);
        const after = fs.readFileSync("./status.json", "utf8");
        assert.equal(after, before);
    });

    await test("CLI без секретов exit 0", () => {
        const proc = spawnSync(process.execPath, ["seo.js"], {
            cwd: process.cwd(),
            env: { ...process.env, GSC_CLIENT_SECRET_JSON: "", GSC_ACCOUNTS_JSON: "" },
            encoding: "utf8",
        });
        assert.equal(proc.status, 0, proc.stderr);
        assert.ok(proc.stdout.includes("GSC не настроен"));
    });

    await test("объём: ~426 главных в день, внутренние из CSV (~3k) за ~2 дня", () => {
        const sites = JSON.parse(fs.readFileSync("./sites.json", "utf8"));
        const catalog = loadCatalogByDomain(fs.readFileSync("./sites.csv", "utf8"));
        const hosts = uniqueMonitoredHosts(sites);
        let skip = 0;
        let homes = 0;
        let inner = 0;
        for (const h of hosts) {
            const row = catalog.get(h.host);
            const account = String(row?.account || "").trim();
            if (!row || !account) {
                skip += 1;
                continue;
            }
            homes += 1;
            inner += Math.max(0, pageTargetsForRow(h.host, row).length - 1);
        }
        assert.equal(skip, 7);
        assert.ok(homes >= 400 && homes <= 450, `homes=${homes}`);
        const left = 1800 - homes;
        assert.ok(left > 1000, `остаток квоты ${left}`);
        assert.ok(inner >= 2500 && inner <= 3500, `inner=${inner}`);
        assert.ok(inner / left < 3, `круг внутренних ${inner / left} дней`);
    });

    await test("withTimeout не висит бесконечно", async () => {
        const start = Date.now();
        let threw = false;
        try {
            await withTimeout(new Promise(() => {}), 40, "t");
        } catch (err) {
            threw = true;
            assert.equal(err.code, 408);
        }
        assert.equal(threw, true);
        assert.ok(Date.now() - start < 400);
    });

    await test("inspectHttpError читает message из JSON Google", () => {
        assert.equal(
            inspectHttpError(403, { error: { status: "PERMISSION_DENIED", message: "nope" } }, ""),
            "PERMISSION_DENIED: nope",
        );
        assert.equal(inspectHttpError(401, null, "Unauthorized"), "Unauthorized");
        assert.equal(inspectHttpError(500, null, ""), "HTTP 500");
    });

    await test("googleapis freeze'ит searchconsole: sc.oauth2 нельзя записать", () => {
        const { google } = require("googleapis");
        const auth = new google.auth.OAuth2("id", "secret");
        const sc = google.searchconsole({ version: "v1", auth });
        assert.equal(Object.isFrozen(sc), true);
        sc.oauth2 = auth;
        assert.equal(sc.oauth2, undefined);
        assert.equal(typeof sc.context._options.auth.getAccessToken, "function");
    });

    await test("hostFromSiteUrl", () => {
        assert.equal(hostFromSiteUrl("https://WWW.Example.COM/path"), "example.com");
        assert.equal(hostFromSiteUrl("not a url"), "");
    });

    if (failed) {
        console.error(`\n${failed} failed`);
        process.exit(1);
    }
    console.log("\nall tests passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
