const assert = require("assert");
const { addDays, gscWindows, sumWindow, buildGscRecord } = require("./gsc");

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

(async () => {
    await test("окна: вчера и два куска по 7 дней", () => {
        const windows = gscWindows(new Date("2026-09-24T12:00:00Z"));
        assert.equal(addDays("2026-09-23", -6), "2026-09-17");
        assert.equal(windows.end, addDays(windows.start, 6));
        assert.equal(windows.prevEnd, addDays(windows.start, -1));
        assert.equal(windows.prevStart, addDays(windows.prevEnd, -6));
    });

    await test("сумма кликов и позиция с весом показов", () => {
        const rows = [
            { keys: ["2026-09-17"], clicks: 10, impressions: 100, position: 10 },
            { keys: ["2026-09-18"], clicks: 0, impressions: 50, position: 20 },
            { keys: ["2026-09-10"], clicks: 1, impressions: 10, position: 5 },
        ];
        const current = sumWindow(rows, "2026-09-17", "2026-09-23");
        assert.equal(current.clicks, 10);
        assert.equal(current.impressions, 150);
        assert.equal(current.position, 13.33);
        assert.equal(current.ctr, 10 / 150);
        const prev = sumWindow(rows, "2026-09-10", "2026-09-16");
        assert.equal(prev.clicks, 1);
        assert.equal(prev.impressions, 10);
    });

    await test("пустой ответ — нули, не ошибка", () => {
        const windows = {
            start: "2026-09-17",
            end: "2026-09-23",
            prevStart: "2026-09-10",
            prevEnd: "2026-09-16",
        };
        const rec = buildGscRecord({
            rows: [],
            siteUrl: "sc-domain:a.com",
            windows,
            checkedAt: "2026-09-24T00:00:00.000Z",
            error: null,
        });
        assert.equal(rec.clicks, 0);
        assert.equal(rec.impressions, 0);
        assert.equal(rec.position, null);
        assert.equal(rec.error, null);
    });

    if (failed) {
        console.error(`${failed} failed`);
        process.exit(1);
    }
})();
