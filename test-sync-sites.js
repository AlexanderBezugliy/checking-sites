const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    hostKey,
    nsFromRow,
    collectCsvHosts,
    syncMonitorList,
    syncSitesFiles,
} = require("./sync-sites");

let failed = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`ok  ${name}`);
    } catch (err) {
        failed += 1;
        console.error(`FAIL ${name}`);
        console.error(err);
    }
}

const sitesCsv = `enabled,domain,account,ns1,ns2
false,Alpha.com,a@x.com,ns1.example.com,ns2.example.com
false,www.beta.com,b@x.com,one.ns.cloudflare.com,two.ns.cloudflare.com
false,bet-rino.co.uk,keep@x.com,lochlan.ns.cloudflare.com,ollie.ns.cloudflare.com
false,bet-rino.co.uk,,,
`;

const dropsCsv = `enabled,domain,source_domain,account,ns1,ns2,redirect
false,drop-one.co.uk,alpha.com,c@x.com,elisabeth.ns.cloudflare.com,maxim.ns.cloudflare.com,301
,,,,,,,,,,
false,alpha.com,ignored.com,d@x.com,ns1.example.com,ns2.example.com,canonical
`;

test("hostKey strips www and case", () => {
    assert.equal(hostKey("WWW.Alpha.com."), "alpha.com");
});

test("nsFromRow lowercases and skips empty", () => {
    assert.deepEqual(
        nsFromRow({ ns1: "Nina.ns.cloudflare.com.", ns2: "" }),
        ["nina.ns.cloudflare.com"],
    );
});

test("CSV union prefers the row with account, then ns", () => {
    const { map, order } = collectCsvHosts(sitesCsv, dropsCsv);
    assert.deepEqual(order, [
        "alpha.com",
        "beta.com",
        "bet-rino.co.uk",
        "drop-one.co.uk",
    ]);
    assert.equal(map.get("bet-rino.co.uk").account, "keep@x.com");
    assert.equal(map.has("alpha.com"), true);
});

test("sync appends new hosts, updates ns, drops leftover and dupes", () => {
    const existing = [
        { url: "https://alpha.com", ns: ["old.ns.example"] },
        { url: "https://alpha.com", ns: ["old.ns.example"] },
        { url: "https://gone.example" },
    ];
    const next = syncMonitorList(existing, sitesCsv, dropsCsv);
    assert.deepEqual(
        next.map((s) => s.url),
        [
            "https://alpha.com",
            "https://beta.com",
            "https://bet-rino.co.uk",
            "https://drop-one.co.uk",
        ],
    );
    assert.deepEqual(next[0].ns, ["ns1.example.com", "ns2.example.com"]);
    assert.ok(!next.some((s) => s.url.includes("gone.example")));
});

test("writes sites.json from both CSVs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-sites-"));
    const jsonPath = path.join(dir, "sites.json");
    fs.writeFileSync(jsonPath, "[]\n");
    fs.writeFileSync(path.join(dir, "sites.csv"), sitesCsv);
    fs.writeFileSync(path.join(dir, "drops.csv"), dropsCsv);
    const result = syncSitesFiles({
        sitesJsonPath: jsonPath,
        sitesCsvPath: path.join(dir, "sites.csv"),
        dropsCsvPath: path.join(dir, "drops.csv"),
    });
    assert.equal(result.after, 4);
    assert.equal(result.added.length, 4);
    const written = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    assert.equal(written.length, 4);
    assert.equal(written[3].url, "https://drop-one.co.uk");
});

if (failed) process.exit(1);
