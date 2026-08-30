const http = require('node:http');
const { URL } = require('node:url');

const port = Number(process.env.PORT || 8787);
const cometManifestUrl = process.env.COMET_MANIFEST_URL;
const realDebridApiKey = process.env.REAL_DEBRID_API_KEY;
const upstreamTimeoutMs = 12_000;
const windowMs = 60_000;
const maxRequests = 60;
const clients = new Map();

if (!cometManifestUrl) {
    console.error('COMET_MANIFEST_URL is required');
    process.exitCode = 1;
}

const allowedTypes = new Set(['movie', 'series', 'channel', 'tv']);
const isSafeSegment = (value) => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,256}$/.test(value);

const upstreamUrl = (type, id) => {
    const manifest = new URL(cometManifestUrl);
    manifest.pathname = manifest.pathname.replace(/\/manifest(?:\.json)?\/?$/, `/stream/${type}/${encodeURIComponent(id)}.json`);
    if (manifest.pathname === new URL(cometManifestUrl).pathname) {
        manifest.pathname = `${manifest.pathname.replace(/\/$/, '')}/stream/${type}/${encodeURIComponent(id)}.json`;
    }
    return manifest;
};

const fetchJson = async (url) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);
    try {
        const headers = { accept: 'application/json' };
        if (realDebridApiKey) headers.authorization = `Bearer ${realDebridApiKey}`;
        const response = await fetch(url, { headers, signal: controller.signal });
        if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
};

const sanitizeStream = (stream) => {
    const output = {};
    for (const key of ['name', 'description', 'thumbnail', 'url', 'ytId', 'externalUrl', 'behaviorHints', 'filename', 'title', 'infoHash', 'fileIdx']) {
        if (stream && stream[key] !== undefined) output[key] = stream[key];
    }
    return output;
};

const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
};

const rateLimited = (req) => {
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = clients.get(key) || { started: now, count: 0 };
    if (now - entry.started > windowMs) { entry.started = now; entry.count = 0; }
    entry.count += 1;
    clients.set(key, entry);
    return entry.count > maxRequests;
};

const server = http.createServer(async (req, res) => {
    if (rateLimited(req)) return send(res, 429, { error: 'Too many requests' });
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
        if (url.pathname === '/api/health') return send(res, 200, { ok: Boolean(cometManifestUrl) });
        if (url.pathname === '/api/comet/manifest.json') {
            const manifest = await fetchJson(cometManifestUrl);
            return send(res, 200, { ...manifest, idPrefixes: manifest.idPrefixes || [] });
        }
        const match = url.pathname.match(/^\/api\/streams\/([^/]+)\/([^/]+)$/);
        const cometMatch = url.pathname.match(/^\/api\/comet\/stream\/([^/]+)\/([^/]+)\.json$/);
        const selected = match || cometMatch;
        if (selected) {
            const [, type, id] = selected;
            if (!allowedTypes.has(type) || !isSafeSegment(id)) return send(res, 400, { error: 'Invalid stream parameters' });
            const data = await fetchJson(upstreamUrl(type, id));
            return send(res, 200, { streams: Array.isArray(data.streams) ? data.streams.map(sanitizeStream) : [] });
        }
        return send(res, 404, { error: 'Not found' });
    } catch (error) {
        return send(res, 502, { error: 'Stream provider unavailable' });
    }
});

server.listen(port, () => console.log(`Stream backend listening on ${port}`));
