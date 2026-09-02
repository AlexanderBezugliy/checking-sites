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
    applyIndexToStatusData,
    inspectUrlWithFallback,
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
        assert.ok(catalog.size >= 440, `доменов ${catalog.size}`);
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

    await test("URL слотов: home → /, login → /login, минус пропускается", () => {
        assert.equal(pageUrlForSlot("example.com", "home"), "https://example.com/");
        assert.equal(pageUrlForSlot("example.com", "login"), "https://example.com/login");
        const pages = pageTargetsForRow("example.com", {
            pages: "home|login|-bonus|register",
        });
        assert.deepEqual(
            pages.map((p) => p.slot),
            ["home", "login", "register"],
        );
        assert.equal(pages[0].url, "https://example.com/");
        assert.ok(!pages.some((p) => p.slot === "bonus"));
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
                pagesCheckedToday: 15,
                pagesIndexed: 2,
                skipped: 7,
                eligible: 10,
            },
        });
        assert.ok(baseline.includes("база записана"));
        assert.ok(baseline.includes("из 10"));
        const authFail = formatAuthFailMessage({
            eligible: 433,
            skipped: 7,
            detail: "invalid_client",
        });
        assert.ok(authFail.includes("прогон не начался"));
        assert.ok(!authFail.includes("база записана"));
        const change = formatSeoMessage({
            isBaseline: false,
            diff,
            stats: {},
        });
        assert.ok(change.includes("Выпали из индекса"));
        assert.ok(change.includes("Попали в индекс"));
        assert.equal(
            formatSeoMessage({
                isBaseline: false,
                diff: { dropped: [], recovered: [], errors: [] },
                stats: {},
            }),
            null,
        );
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
                    url: "https://a.com/login",
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
            const indexed = inspectionUrl.endsWith("/") || inspectionUrl.endsWith("/login");
            return {
                ok: true,
                status: 200,
                json: indexed ? passJson() : failJson(),
                error: null,
            };
        };
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
            quotaLimit: 3,
            sitesPath,
            csvPath,
            statusPath,
        });
        assert.equal(day1.skipped, false);
        assert.equal(day1.isBaseline, true);
        assert.equal(day1.stats.homesChecked, 2);
        assert.equal(day1.stats.pagesCheckedToday, 3);
        assert.equal(calls.length, 3);
        assert.ok(calls.every((c) => c.siteUrl.startsWith("sc-domain:")));

        const after1 = JSON.parse(fs.readFileSync(statusPath, "utf8"));
        assert.equal(after1.last_update, "2026-09-01T00:00:00Z");
        assert.ok(after1.index_last_update);
        assert.equal(after1.data[0].status, 503);
        assert.equal(after1.data[0].index.indexed, true);
        assert.ok(after1.data[0].index.pages.some((p) => p.slot === "home"));

        const day2 = await runSeo({
            env,
            inspectFn,
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

        fs.rmSync(dir, { recursive: true, force: true });
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

    await test("объём: ~436 главных в день, внутренние за ~2 дня в квоту 1800", () => {
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
            const pages = pageTargetsForRow(h.host, row);
            homes += 1;
            inner += Math.max(0, pages.length - 1);
        }
        assert.equal(skip, 7);
        assert.ok(homes >= 400 && homes <= 450, `homes=${homes}`);
        const left = 1800 - homes;
        assert.ok(left > 1000, `остаток квоты ${left}`);
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
