const {
    HTTP_TIMEOUT_MS,
    REDIRECT_STATUSES,
    withCloakView,
    isSamePathRedirect,
    hopFromResponse,
} = require("./subfolder");

const BODY_LIMIT = 32 * 1024;
const SHORT_BODY = 2 * 1024;
const CHROME_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CHROME_HEADERS = {
    "User-Agent": CHROME_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
};

function rootUrl(siteUrl) {
    const u = new URL(siteUrl);
    return `${u.protocol}//${u.host}/`;
}

function cloakPayload({
    present = null,
    status = null,
    error = null,
    http = null,
} = {}) {
    return {
        present: present === true ? true : present === false ? false : null,
        status: status === 503 ? 503 : null,
        error: error || null,
        http: Number.isInteger(http) ? http : null,
    };
}

function cloakForUnreachable(error) {
    return cloakPayload({
        present: null,
        status: null,
        error: error || null,
        http: null,
    });
}

function fetchOptsB() {
    return {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    };
}

function fetchOptsA() {
    return {
        ...fetchOptsB(),
        headers: { ...CHROME_HEADERS },
    };
}

function isBlocked(hop) {
    return hop && hop.status === 403;
}

function siteOpened(hop) {
    if (!hop || hop.foreign) return false;
    if (hop.status === 200) return true;
    if (
        REDIRECT_STATUSES.has(hop.status) &&
        hop.location &&
        isSamePathRedirect(hop.url, hop.location)
    ) {
        return true;
    }
    return false;
}

function aNotClassifiedError(hopA) {
    const code = hopA && hopA.status != null ? hopA.status : "empty";
    return `A ${code}, not 200/503`;
}

function innerText(html, tag) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
    const m = String(html || "").match(re);
    if (!m) return "";
    return m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function isStub503(html) {
    const text = String(html || "");
    const heading = `${innerText(text, "title")} ${innerText(text, "h1")}`;
    if (/503|service\s*unavailable/i.test(heading)) return true;
    if (text.length < SHORT_BODY && /503|unavailable/i.test(text)) return true;
    return false;
}

async function readBody(hop) {
    if (!hop?.response || typeof hop.response.text !== "function") return "";
    try {
        const raw = await hop.response.text();
        return String(raw || "").slice(0, BODY_LIMIT);
    } catch {
        return "";
    }
}

async function fetchHop(url, fetchFn, opts) {
    const response = await fetchFn(url, opts);
    return hopFromResponse(url, response);
}

async function followSamePathOnce(hop, fetchFn) {
    if (!hop || hop.foreign || !hop.location) return hop;
    if (!REDIRECT_STATUSES.has(hop.status)) return hop;
    if (!isSamePathRedirect(hop.url, hop.location)) return hop;
    const dest = new URL(hop.location, hop.url);
    dest.search = "";
    dest.hash = "";
    return fetchHop(dest.toString(), fetchFn, fetchOptsA());
}

function cloakFrom503(hopB, http) {
    if (siteOpened(hopB)) {
        return cloakPayload({ present: true, status: 503, http });
    }
    if (hopB?.foreign) {
        return cloakPayload({ error: "foreign redirect", http });
    }
    return cloakPayload({ error: "bypass not confirmed", http });
}

async function checkCloak(siteUrl, { hopA, hopAError, hopB, fetchFn = fetch } = {}) {
    if (hopAError) {
        return cloakPayload({
            error: hopAError.message || String(hopAError),
        });
    }

    try {
        const aUrl = rootUrl(siteUrl);
        const resolvedA = hopA || (await fetchHop(aUrl, fetchFn, fetchOptsA()));
        const resolvedB =
            hopB || (await fetchHop(withCloakView(aUrl), fetchFn, fetchOptsB()));
        const http = Number.isInteger(resolvedA.status) ? resolvedA.status : null;

        if (resolvedA.foreign) {
            return cloakPayload({ error: "foreign redirect", http });
        }

        if (resolvedA.status === 200) {
            const body = await readBody(resolvedA);
            if (isStub503(body)) return cloakFrom503(resolvedB, http);
            return cloakPayload({ present: false, http });
        }

        if (isBlocked(resolvedA) || isBlocked(resolvedB)) {
            return cloakPayload({ error: "probe blocked", http });
        }

        if (resolvedA.status === 503) {
            return cloakFrom503(resolvedB, http);
        }

        const samePathA =
            REDIRECT_STATUSES.has(resolvedA.status) &&
            isSamePathRedirect(resolvedA.url, resolvedA.location);
        if (samePathA) {
            const followed = await followSamePathOnce(resolvedA, fetchFn);
            if (isBlocked(followed)) {
                return cloakPayload({ error: "probe blocked", http });
            }
            if (followed.foreign) {
                return cloakPayload({ error: "foreign redirect", http });
            }
            if (followed.status === 503) {
                return cloakFrom503(resolvedB, http);
            }
            if (followed.status === 200) {
                const body = await readBody(followed);
                if (isStub503(body)) return cloakFrom503(resolvedB, http);
            }
        }

        return cloakPayload({ error: aNotClassifiedError(resolvedA), http });
    } catch (err) {
        return cloakPayload({
            error: err.message || "cloak check failed",
        });
    }
}

function logCloak(results) {
    let yes = 0;
    let no = 0;
    let skip = 0;
    for (const row of results) {
        const p = row.cloak?.present;
        if (p === true) yes += 1;
        else if (p === false) no += 1;
        else skip += 1;
    }
    console.log(`Cloak: ${yes} present, ${no} absent, ${skip} skip`);
}

module.exports = {
    CHROME_UA,
    rootUrl,
    cloakPayload,
    cloakForUnreachable,
    checkCloak,
    isStub503,
    logCloak,
};
