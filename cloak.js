const {
    HTTP_TIMEOUT_MS,
    REDIRECT_STATUSES,
    withCloakView,
    isSamePathRedirect,
    hopFromResponse,
} = require("./subfolder");

function rootUrl(siteUrl) {
    const u = new URL(siteUrl);
    return `${u.protocol}//${u.host}/`;
}

function cloakPayload({ present = null, status = null, error = null } = {}) {
    return {
        present: present === true ? true : present === false ? false : null,
        status: status === 503 ? 503 : null,
        error: error || null,
    };
}

function cloakForUnreachable(error) {
    return cloakPayload({
        present: null,
        status: null,
        error: error || null,
    });
}

function fetchOpts() {
    return {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
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

async function fetchHop(url, fetchFn) {
    const response = await fetchFn(url, fetchOpts());
    return hopFromResponse(url, response);
}

async function followSamePathOnce(hop, fetchFn) {
    if (!hop || hop.foreign || !hop.location) return hop;
    if (!REDIRECT_STATUSES.has(hop.status)) return hop;
    if (!isSamePathRedirect(hop.url, hop.location)) return hop;
    const dest = new URL(hop.location, hop.url);
    dest.search = "";
    dest.hash = "";
    return fetchHop(dest.toString(), fetchFn);
}

function classifyPair(hopA, hopB, aEffective503) {
    if (isBlocked(hopA) || isBlocked(hopB)) {
        return cloakPayload({ error: "probe blocked" });
    }
    if (hopA.foreign) {
        return cloakPayload({ error: "foreign redirect" });
    }

    const opened = siteOpened(hopB);
    if ((hopA.status === 503 || aEffective503) && opened) {
        return cloakPayload({ present: true, status: 503 });
    }
    if (hopA.status === 200) {
        return cloakPayload({ present: false });
    }
    if (hopA.status === 503 && !opened) {
        if (hopB?.foreign) {
            return cloakPayload({ error: "foreign redirect" });
        }
        return cloakPayload({ error: "bypass not confirmed" });
    }
    return null;
}

async function checkCloak(siteUrl, { hopA, hopAError, hopB, fetchFn = fetch } = {}) {
    if (hopAError) {
        return cloakPayload({
            error: hopAError.message || String(hopAError),
        });
    }

    try {
        const aUrl = rootUrl(siteUrl);
        const resolvedA =
            hopA || (await fetchHop(aUrl, fetchFn));
        const resolvedB =
            hopB || (await fetchHop(withCloakView(aUrl), fetchFn));

        const direct = classifyPair(resolvedA, resolvedB, false);
        if (direct) return direct;

        const samePathA =
            REDIRECT_STATUSES.has(resolvedA.status) &&
            !resolvedA.foreign &&
            isSamePathRedirect(resolvedA.url, resolvedA.location);
        if (samePathA) {
            const followed = await followSamePathOnce(resolvedA, fetchFn);
            if (isBlocked(followed)) {
                return cloakPayload({ error: "probe blocked" });
            }
            if (followed.foreign) {
                return cloakPayload({ error: "foreign redirect" });
            }
            if (followed.status === 200) {
                return cloakPayload({ present: false });
            }
            if (followed.status === 503) {
                const after503 = classifyPair(resolvedA, resolvedB, true);
                if (after503) return after503;
            }
        }

        return cloakPayload({ present: false });
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
    rootUrl,
    cloakPayload,
    cloakForUnreachable,
    checkCloak,
    logCloak,
};
