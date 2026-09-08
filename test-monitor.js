const assert = require("assert");
const {
    parseSubfolderField,
    loadSubfolderByHost,
    loadSubfolderCatalog,
    parsedSubfolderForUrl,
    subfolderForUnreachable,
    checkSubfolder,
    extractCanonicalHref,
} = require("./subfolder");

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

function fakeResponse({ status, location = null, body = "" }) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: {
            get(name) {
                if (String(name).toLowerCase() === "location") return location;
                return null;
            },
        },
        async text() {
            return body;
        },
    };
}

function pathKey(url) {
    const u = new URL(url);
    let p = u.pathname || "/";
    if (p.length > 1 && !p.endsWith("/")) p += "/";
    return p;
}

function makeFetch(routes) {
    return async (url) => {
        const u = new URL(url);
        const key = pathKey(u);
        const handler = routes[key];
        if (!handler) return fakeResponse({ status: 404 });
        if (typeof handler === "function") return handler(u);
        return fakeResponse(handler);
    };
}

function htmlCanonical(href) {
    return `<!doctype html><html><head><link rel="canonical" href="${href}"></head></html>`;
}

async function main() {
    await test("parser: folder/mode/rewrite", () => {
        assert.deepEqual(parseSubfolderField(""), {
            folder: null,
            csv: null,
            mode: null,
            page: null,
        });
        assert.deepEqual(parseSubfolderField("en-gb[home]"), {
            folder: "en-gb",
            csv: "en-gb[home]",
            mode: "home",
            page: null,
        });
        assert.deepEqual(parseSubfolderField("en-gb[all]"), {
            folder: "en-gb",
            csv: "en-gb[all]",
            mode: "all",
            page: null,
        });
        assert.deepEqual(parseSubfolderField("it[home]:rewrite:root"), {
            folder: "it",
            csv: "it[home]:rewrite:root",
            mode: "home",
            page: null,
        });
        assert.deepEqual(parseSubfolderField("en-gb[home]:rewrite:prev"), {
            folder: "en-gb",
            csv: "en-gb[home]:rewrite:prev",
            mode: "home",
            page: null,
        });
        assert.deepEqual(parseSubfolderField("it-it[all]"), {
            folder: "it-it",
            csv: "it-it[all]",
            mode: "all",
            page: null,
        });
        assert.equal(parseSubfolderField("en-gb").mode, "home");
        assert.equal(parseSubfolderField("en-gb[faq]").mode, "page");
        assert.equal(parseSubfolderField("en-gb[faq]").page, "faq");
        assert.equal(parseSubfolderField("EN-GB[HOME]").folder, "en-gb");
    });

    await test("catalog: hostname → CSV subfolder", () => {
        const catalog = loadSubfolderCatalog();
        const bass = catalog.get("basswincasino-official.com");
        assert.equal(bass.folder, "en-gb");
        assert.equal(bass.mode, "home");
        const empty = parsedSubfolderForUrl(catalog, "https://ek333-bd.org");
        assert.equal(empty.folder, null);
        assert.equal(empty.csv, null);
        const missing = parsedSubfolderForUrl(catalog, "https://airnaturel.co.uk");
        assert.equal(missing.folder, null);
        const map = loadSubfolderByHost(
            "domain,subfolder\nwww.Example.com,en-gb[all]\n",
        );
        assert.equal(map.get("example.com").folder, "en-gb");
        assert.equal(map.get("example.com").mode, "all");
    });

    await test("canonical href: rel до и после href", () => {
        assert.equal(
            extractCanonicalHref('<link rel="canonical" href="https://a.com/en-gb/">'),
            "https://a.com/en-gb/",
        );
        assert.equal(
            extractCanonicalHref("<link href='https://a.com/it/' rel='canonical'>"),
            "https://a.com/it/",
        );
    });

    await test("мёртвый сайт: folder из CSV, match/glue null", () => {
        const parsed = parseSubfolderField("en-gb[home]");
        const row = subfolderForUnreachable(parsed, "домен не резолвится");
        assert.equal(row.folder, "en-gb");
        assert.equal(row.csv, "en-gb[home]");
        assert.equal(row.mode, "home");
        assert.equal(row.match, null);
        assert.equal(row.glue, null);
        assert.equal(row.live_folder, null);
        assert.equal(row.error, "домен не резолвится");
    });

    await test("money: два 200 + canonical → match true, glue canonical", async () => {
        const site = "https://money.test";
        const out = await checkSubfolder(site, "en-gb[home]", {
            fetchFn: makeFetch({
                "/": {
                    status: 200,
                    body: htmlCanonical("https://money.test/en-gb/"),
                },
                "/en-gb/": { status: 200, body: "ok" },
            }),
        });
        assert.equal(out.folder, "en-gb");
        assert.equal(out.match, true);
        assert.equal(out.glue, "canonical");
        assert.equal(out.live_folder, null);
        assert.equal(out.error, null);
        assert.notEqual(out.glue, "302");
    });

    await test("клоака 302 на / — это не glue 301", async () => {
        const site = "https://cloak.test";
        const out = await checkSubfolder(site, "en-gb[home]", {
            fetchFn: makeFetch({
                "/": (u) => {
                    if (u.searchParams.has("view")) {
                        return fakeResponse({ status: 302, location: "/" });
                    }
                    return fakeResponse({
                        status: 200,
                        body: htmlCanonical("https://cloak.test/en-gb/"),
                    });
                },
                "/en-gb/": { status: 200, body: "ok" },
            }),
        });
        assert.equal(out.glue, "canonical");
        assert.notEqual(out.glue, "301");
        assert.notEqual(out.glue, "302");
        assert.equal(out.match, true);
    });

    await test("301 Location /en-gb/ с корня → glue 301", async () => {
        const site = "https://drop.test";
        const out = await checkSubfolder(site, "en-gb[home]", {
            fetchFn: makeFetch({
                "/": { status: 301, location: "/en-gb/" },
                "/en-gb/": { status: 200, body: "ok" },
            }),
        });
        assert.equal(out.glue, "301");
        assert.equal(out.match, true);
        assert.notEqual(out.glue, "302");
    });

    await test("CSV пустой + self-canonical → всё null", async () => {
        const site = "https://plain.test";
        const out = await checkSubfolder(site, "", {
            fetchFn: makeFetch({
                "/": {
                    status: 200,
                    body: htmlCanonical("https://plain.test/"),
                },
            }),
        });
        assert.equal(out.folder, null);
        assert.equal(out.csv, null);
        assert.equal(out.mode, null);
        assert.equal(out.match, null);
        assert.equal(out.glue, null);
        assert.equal(out.live_folder, null);
        assert.equal(out.error, null);
    });

    await test("CSV en-gb + 404 /en-gb/ → match false", async () => {
        const site = "https://miss.test";
        const out = await checkSubfolder(site, "en-gb[home]", {
            fetchFn: makeFetch({
                "/": {
                    status: 200,
                    body: htmlCanonical("https://miss.test/"),
                },
                "/en-gb/": { status: 404, body: "no" },
            }),
        });
        assert.equal(out.folder, "en-gb");
        assert.equal(out.match, false);
        assert.equal(out.glue, null);
    });

    await test("302 на /en-gb/ не пишется как glue", async () => {
        const site = "https://tmp.test";
        const out = await checkSubfolder(site, "en-gb[home]", {
            fetchFn: makeFetch({
                "/": { status: 302, location: "/en-gb/" },
                "/en-gb/": { status: 200, body: "ok" },
            }),
        });
        assert.equal(out.glue, null);
        assert.notEqual(out.glue, "302");
        assert.equal(out.match, null);
    });

    await test("чужой 301 → glue null, match null", async () => {
        const site = "https://closed.test";
        const out = await checkSubfolder(site, "en-gb[all]", {
            fetchFn: makeFetch({
                "/": { status: 301, location: "https://other-money.test/" },
            }),
        });
        assert.equal(out.folder, "en-gb");
        assert.equal(out.mode, "all");
        assert.equal(out.glue, null);
        assert.equal(out.match, null);
        assert.equal(out.error, "foreign redirect");
    });

    await test("CSV пусто, а canonical уезжает в /it/ → match false, live_folder", async () => {
        const site = "https://surprise.test";
        const out = await checkSubfolder(site, null, {
            fetchFn: makeFetch({
                "/": {
                    status: 200,
                    body: htmlCanonical("https://surprise.test/it/"),
                },
                "/it/": { status: 200, body: "ok" },
            }),
        });
        assert.equal(out.folder, null);
        assert.equal(out.match, false);
        assert.equal(out.glue, "canonical");
        assert.equal(out.live_folder, "it");
    });

    await test("[all]: без внутренней в подпапке match false", async () => {
        const site = "https://all.test";
        const out = await checkSubfolder(site, "en-gb[all]", {
            fetchFn: makeFetch({
                "/": {
                    status: 200,
                    body: htmlCanonical("https://all.test/en-gb/"),
                },
                "/en-gb/": { status: 200, body: "ok" },
                "/login/": { status: 200, body: "root login is not subfolder" },
            }),
        });
        assert.equal(out.glue, "canonical");
        assert.equal(out.match, false);
    });

    await test("[all]: /{folder}/login/ 200 → match true", async () => {
        const site = "https://allok.test";
        const out = await checkSubfolder(site, "en-gb[all]", {
            fetchFn: makeFetch({
                "/": {
                    status: 200,
                    body: htmlCanonical("https://allok.test/en-gb/"),
                },
                "/en-gb/": { status: 200, body: "ok" },
                "/en-gb/login/": { status: 200, body: "ok" },
            }),
        });
        assert.equal(out.match, true);
        assert.equal(out.glue, "canonical");
    });

    await test("клоака 302 после view, затем 301 на папку", async () => {
        const site = "https://cloakdrop.test";
        const out = await checkSubfolder(site, "it[home]:rewrite:root", {
            fetchFn: makeFetch({
                "/": (u) => {
                    if (u.searchParams.has("view")) {
                        return fakeResponse({ status: 302, location: "/" });
                    }
                    return fakeResponse({ status: 301, location: "/it/" });
                },
                "/it/": { status: 200, body: "ok" },
            }),
        });
        assert.equal(out.folder, "it");
        assert.equal(out.glue, "301");
        assert.equal(out.match, true);
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
