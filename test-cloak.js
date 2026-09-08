const assert = require("assert");
const { withCloakView } = require("./subfolder");
const {
    checkCloak,
    cloakForUnreachable,
    cloakPayload,
    CHROME_UA,
} = require("./cloak");

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

function makeFetch({ bare, withView }) {
    return async (url) => {
        const u = new URL(url);
        const table = u.searchParams.has("view") ? withView : bare;
        const key = u.pathname === "/" || u.pathname === "" ? "/" : u.pathname;
        const handler = table[key] ?? table["/"];
        if (!handler) return fakeResponse({ status: 404 });
        if (typeof handler === "function") return handler(u);
        return fakeResponse(handler);
    };
}

async function main() {
    const site = "https://cloak.test";

    await test("A без view, B с ?view=d7Fm2Kp9Qx4Nw8Rz", async () => {
        const seen = [];
        const fetchFn = async (url) => {
            seen.push(url);
            const u = new URL(url);
            if (u.searchParams.get("view") === "d7Fm2Kp9Qx4Nw8Rz") {
                return fakeResponse({ status: 200, body: "ok" });
            }
            return fakeResponse({ status: 503, body: "stub" });
        };
        const out = await checkCloak(site, { fetchFn });
        assert.equal(out.present, true);
        assert.equal(seen.length, 2);
        const a = new URL(seen[0]);
        const b = new URL(seen[1]);
        assert.equal(a.searchParams.has("view"), false);
        assert.equal(a.pathname, "/");
        assert.equal(b.searchParams.get("view"), "d7Fm2Kp9Qx4Nw8Rz");
        assert.equal(b.pathname, "/");
    });

    await test("A шлёт Chrome UA, B без этих заголовков", async () => {
        const seen = [];
        const fetchFn = async (url, opts) => {
            seen.push({
                view: new URL(url).searchParams.has("view"),
                ua: opts && opts.headers && opts.headers["User-Agent"],
                accept: opts && opts.headers && opts.headers.Accept,
                lang: opts && opts.headers && opts.headers["Accept-Language"],
            });
            const u = new URL(url);
            if (u.searchParams.get("view") === "d7Fm2Kp9Qx4Nw8Rz") {
                return fakeResponse({ status: 200, body: "ok" });
            }
            return fakeResponse({ status: 503, body: "stub" });
        };
        await checkCloak(site, { fetchFn });
        const a = seen.find((s) => !s.view);
        const b = seen.find((s) => s.view);
        assert.ok(a && b);
        assert.equal(a.ua, CHROME_UA);
        assert.ok(String(a.accept).includes("text/html"));
        assert.equal(a.lang, "en-GB,en;q=0.9");
        assert.equal(b.ua, undefined);
    });

    await test("A=503 + B=200 → present true, status 503", async () => {
        const out = await checkCloak(site, {
            fetchFn: makeFetch({
                bare: { "/": { status: 503, body: "stub" } },
                withView: { "/": { status: 200, body: "ok" } },
            }),
        });
        assert.equal(out.present, true);
        assert.equal(out.status, 503);
        assert.equal(out.error, null);
    });

    await test("A=200 + B=200 → present false", async () => {
        const casino = `<!doctype html><html><head><title>TopBet24 Casino</title></head><body>${"welcome ".repeat(400)}</body></html>`;
        const out = await checkCloak(site, {
            fetchFn: makeFetch({
                bare: { "/": { status: 200, body: casino } },
                withView: { "/": { status: 200, body: casino } },
            }),
        });
        assert.equal(out.present, false);
        assert.equal(out.status, null);
        assert.equal(out.error, null);
        assert.equal(out.http, 200);
    });

    await test("A=200, title 503 Service Unavailable → present true", async () => {
        const stub =
            "<html><head><title>503 Service Unavailable</title></head><body>unavailable</body></html>";
        const out = await checkCloak(site, {
            fetchFn: makeFetch({
                bare: { "/": { status: 200, body: stub } },
                withView: { "/": { status: 200, body: "ok" } },
            }),
        });
        assert.equal(out.present, true);
        assert.equal(out.status, 503);
        assert.equal(out.http, 200);
        assert.notEqual(out.status, 302);
    });

    await test("A=503 + B=302 Location / тот же хост → true", async () => {
        const out = await checkCloak(site, {
            fetchFn: makeFetch({
                bare: { "/": { status: 503, body: "stub" } },
                withView: { "/": { status: 302, location: "/" } },
            }),
        });
        assert.equal(out.present, true);
        assert.equal(out.status, 503);
        assert.notEqual(out.status, 302);
    });

    await test("аптайм 302 без запроса A → present null, не true", async () => {
        const hopB = {
            status: 302,
            location: "/",
            url: withCloakView(`${site}/`),
            foreign: false,
        };
        const out = await checkCloak(site, {
            hopB,
            hopAError: new Error("timeout"),
        });
        assert.equal(out.present, null);
        assert.equal(out.status, null);
        assert.ok(out.error);
    });

    await test("DNS → present null", () => {
        const out = cloakForUnreachable("домен не резолвится");
        assert.deepEqual(out, {
            present: null,
            status: null,
            error: "домен не резолвится",
            http: null,
        });
    });

    await test("payload никогда не пишет status 302", () => {
        const out = cloakPayload({ present: true, status: 302, http: 302 });
        assert.equal(out.status, null);
        assert.equal(out.present, true);
        assert.equal(out.http, 302);
    });

    await test("A=403 → present null, probe blocked", async () => {
        const out = await checkCloak(site, {
            fetchFn: makeFetch({
                bare: { "/": { status: 403, body: "cf" } },
                withView: { "/": { status: 200, body: "ok" } },
            }),
        });
        assert.equal(out.present, null);
        assert.equal(out.status, null);
        assert.equal(out.error, "probe blocked");
    });

    await test("A=503 + B foreign → present null", async () => {
        const out = await checkCloak(site, {
            fetchFn: makeFetch({
                bare: { "/": { status: 503, body: "stub" } },
                withView: {
                    "/": { status: 301, location: "https://other.test/" },
                },
            }),
        });
        assert.equal(out.present, null);
        assert.equal(out.error, "foreign redirect");
    });

    await test("A=302 same-path (как mrjames) → present null, не false", async () => {
        const out = await checkCloak(site, {
            fetchFn: makeFetch({
                bare: { "/": { status: 302, location: "/" } },
                withView: { "/": { status: 302, location: "/" } },
            }),
        });
        assert.equal(out.present, null);
        assert.equal(out.status, null);
        assert.equal(out.error, "A 302, not 200/503");
        assert.equal(out.http, 302);
        assert.notEqual(out.present, false);
    });

    await test("A same-path 302 затем 200 → present null, не false", async () => {
        let bareHits = 0;
        const out = await checkCloak(site, {
            fetchFn: makeFetch({
                bare: {
                    "/": () => {
                        bareHits += 1;
                        if (bareHits === 1) {
                            return fakeResponse({ status: 302, location: "/" });
                        }
                        return fakeResponse({ status: 200, body: "ok" });
                    },
                },
                withView: { "/": { status: 200, body: "ok" } },
            }),
        });
        assert.equal(out.present, null);
        assert.equal(out.status, null);
        assert.equal(out.error, "A 302, not 200/503");
        assert.equal(out.http, 302);
    });

    await test("A same-path 302 затем 503 и B открылся → present true", async () => {
        let bareHits = 0;
        const out = await checkCloak(site, {
            fetchFn: makeFetch({
                bare: {
                    "/": () => {
                        bareHits += 1;
                        if (bareHits === 1) {
                            return fakeResponse({ status: 302, location: "/" });
                        }
                        return fakeResponse({ status: 503, body: "stub" });
                    },
                },
                withView: { "/": { status: 200, body: "ok" } },
            }),
        });
        assert.equal(out.present, true);
        assert.equal(out.status, 503);
    });

    await test("аптайм hopB 302 не становится cloak.status", async () => {
        const hopB = {
            status: 302,
            location: "/",
            url: withCloakView(`${site}/`),
            foreign: false,
        };
        const out = await checkCloak(site, {
            hopB,
            fetchFn: makeFetch({
                bare: { "/": { status: 503, body: "stub" } },
                withView: { "/": { status: 302, location: "/" } },
            }),
        });
        assert.equal(out.present, true);
        assert.equal(out.status, 503);
        assert.equal(out.http, 503);
        assert.equal(out.redirect, undefined);
        assert.notEqual(out.status, 302);
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
