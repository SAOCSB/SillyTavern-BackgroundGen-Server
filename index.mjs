/**
 * 后台生成中转 / Background Generation Relay — SillyTavern server plugin.
 *
 * 浏览器把生成请求交给本插件，插件以「同一用户、同一会话」的身份回环调用 SillyTavern 自己的生成接口，
 * 并把上游返回的字节完整缓存下来。浏览器断开（关页面、锁屏、切后台、断网）不会中止上游请求；
 * 浏览器回来后可以从断点续传，或在下次打开聊天时取回完整结果。
 *
 * 只代理 SillyTavern 自己的生成接口，请求内容原样转发，因此与任何 API / 预设 / 插件兼容。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

export const info = {
    id: 'bg-gen',
    name: 'Background Generation Relay',
    description: 'Keeps generations running on the server when the browser disconnects, and lets the page resume or collect the result later.',
};

const VERSION = '1.0.0';
const LOG = '[bg-gen]';
const DATA_DIR = path.join(import.meta.dirname, 'data');
const ALLOWED_TARGETS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/novelai/generate',
]);
const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers',
    'transfer-encoding', 'upgrade', 'content-length', 'content-type', 'content-encoding', 'accept-encoding', 'expect',
]);
const MAX_JOB_BYTES = 64 * 1024 * 1024;
const MAX_MAIN_JOBS_PER_USER = 40;
const MAIN_TTL_MS = 7 * 24 * 3600_000;
const AUX_TTL_MS = 15 * 60_000;
const ACKED_GRACE_MS = 2 * 60_000;
const AUX_DETACHED_ABORT_MS = 5 * 60_000;
const MAX_RUNTIME_MS = 3 * 3600_000;

// 回环请求用独立的普通 Agent：SillyTavern 的私有地址过滤会替换全局 Agent（agent:false 也会继承它），
// 而这里访问的是 SillyTavern 自己，不属于需要拦截的外部请求。
const loopbackAgents = {
    http: new http.Agent({ keepAlive: false }),
    https: new https.Agent({ keepAlive: false, rejectUnauthorized: false }),
};

/** @type {Map<string, Job>} */
const jobs = new Map();
const loadedUsers = new Set();
let sweepTimer = null;

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {string} handle
 * @property {any} meta
 * @property {string} target
 * @property {'main'|'aux'} kind
 * @property {number} createdAt
 * @property {number|null} headAt
 * @property {number|null} finishedAt
 * @property {'running'|'done'|'error'|'aborted'} state
 * @property {{status:number,statusText:string,contentType:string|null}|null} head
 * @property {Buffer[]} chunks
 * @property {number} length
 * @property {string|null} error
 * @property {string|null} owner
 * @property {Set<import('express').Response>} attached
 * @property {number} lastDetachAt
 * @property {boolean} acked
 * @property {number} ackedAt
 * @property {http.ClientRequest|null} upstream
 * @property {Set<() => void>} listeners
 */

// ------------------------------------------------------------------ helpers

function handleOf(req) {
    return req.user?.profile?.handle || null;
}

function safeName(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function validId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(id);
}

function userDir(handle) {
    return path.join(DATA_DIR, safeName(handle));
}

function jobFile(job) {
    return path.join(userDir(job.handle), `${job.id}.json`);
}

function notify(job) {
    for (const fn of [...job.listeners]) {
        try { fn(); } catch (error) { console.warn(LOG, 'listener failed', error); }
    }
}

function publicStatus(job) {
    return {
        id: job.id,
        kind: job.kind,
        state: job.state,
        length: job.length,
        head: job.head,
        error: job.error,
        owner: job.owner,
        attached: job.attached.size,
        acked: job.acked,
        createdAt: job.createdAt,
        headAt: job.headAt,
        finishedAt: job.finishedAt,
        meta: job.meta,
    };
}

function newJob({ id, handle, meta, target, createdAt = Date.now() }) {
    return {
        id,
        handle,
        meta: meta && typeof meta === 'object' ? meta : {},
        target,
        kind: meta?.kind === 'main' ? 'main' : 'aux',
        createdAt,
        headAt: null,
        finishedAt: null,
        state: 'running',
        head: null,
        chunks: [],
        length: 0,
        error: null,
        owner: typeof meta?.client === 'string' ? meta.client : null,
        attached: new Set(),
        lastDetachAt: Date.now(),
        acked: false,
        ackedAt: 0,
        claimedAt: 0,
        upstream: null,
        listeners: new Set(),
    };
}

function append(job, chunk) {
    if (job.state !== 'running') return;
    job.chunks.push(chunk);
    job.length += chunk.length;
    if (job.length > MAX_JOB_BYTES) {
        abortUpstream(job);
        finish(job, 'error', 'response too large');
        return;
    }
    notify(job);
}

function finish(job, state, error = null) {
    if (job.state !== 'running') return;
    job.state = state;
    job.error = error;
    job.finishedAt = Date.now();
    job.upstream = null;
    if (!job.head) {
        // 连接在拿到响应头之前就失败了：模拟 SillyTavern 自己的 502 错误响应
        job.head = { status: 502, statusText: 'Bad Gateway', contentType: 'application/json; charset=utf-8' };
        job.headAt = job.finishedAt;
        const body = Buffer.from(JSON.stringify({ error: { message: error || 'Generation failed' } }));
        job.chunks.push(body);
        job.length += body.length;
    }
    notify(job);
    if (job.kind === 'main' && !job.acked && state !== 'aborted') {
        persist(job).catch(err => console.warn(LOG, 'persist failed', err));
    }
}

function abortUpstream(job) {
    const upstream = job.upstream;
    job.upstream = null;
    if (upstream) {
        try { upstream.destroy(); } catch { /* ignore */ }
    }
}

async function persist(job) {
    const dir = userDir(job.handle);
    await fs.promises.mkdir(dir, { recursive: true });
    const record = {
        v: 1,
        id: job.id,
        handle: job.handle,
        meta: job.meta,
        target: job.target,
        createdAt: job.createdAt,
        headAt: job.headAt,
        finishedAt: job.finishedAt,
        state: job.state,
        head: job.head,
        error: job.error,
        body: Buffer.concat(job.chunks).toString('base64'),
    };
    const file = jobFile(job);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(record));
    await fs.promises.rename(tmp, file);
    if (job.acked) await unpersist(job); // 写盘期间已经被确认，删掉
}

async function unpersist(job) {
    try {
        await fs.promises.unlink(jobFile(job));
    } catch (error) {
        if (error?.code !== 'ENOENT') console.warn(LOG, 'unlink failed', error);
    }
}

function ensureUserLoaded(handle) {
    if (loadedUsers.has(handle)) return;
    loadedUsers.add(handle);
    const dir = userDir(handle);
    let files = [];
    try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch {
        return;
    }
    for (const file of files) {
        const full = path.join(dir, file);
        try {
            const record = JSON.parse(fs.readFileSync(full, 'utf8'));
            if (!validId(record.id) || record.handle !== handle || jobs.has(record.id)) continue;
            if (Date.now() - (record.finishedAt || 0) > MAIN_TTL_MS) {
                fs.unlinkSync(full);
                continue;
            }
            const job = newJob({ id: record.id, handle, meta: record.meta, target: record.target, createdAt: record.createdAt });
            const body = Buffer.from(record.body || '', 'base64');
            job.kind = 'main';
            job.state = ['done', 'error'].includes(record.state) ? record.state : 'error';
            job.head = record.head;
            job.headAt = record.headAt ?? record.finishedAt;
            job.finishedAt = record.finishedAt;
            job.error = record.error;
            job.chunks = body.length ? [body] : [];
            job.length = body.length;
            job.owner = null; // 原页面早已不在
            jobs.set(job.id, job);
        } catch (error) {
            console.warn(LOG, 'failed to load', full, error.message);
        }
    }
}

function forwardHeaders(incoming) {
    const headers = {};
    for (const [key, value] of Object.entries(incoming)) {
        const lower = key.toLowerCase();
        if (lower.startsWith(':') || HOP_BY_HOP.has(lower) || lower.startsWith('x-bg-')) continue;
        headers[lower] = value;
    }
    return headers;
}

function startUpstream(job, req, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    const local = String(req.socket.localAddress || '');
    const host = local.includes(':') && !local.startsWith('::ffff:') ? '::1' : '127.0.0.1';
    const headers = forwardHeaders(req.headers);
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(body.length);
    headers['accept-encoding'] = 'identity';
    headers['x-bg-gen-relay'] = job.id;
    const tls = !!req.socket.encrypted;
    const upstream = (tls ? https : http).request({
        host,
        port: req.socket.localPort,
        method: 'POST',
        path: job.target,
        headers,
        agent: tls ? loopbackAgents.https : loopbackAgents.http,
    });
    job.upstream = upstream;

    upstream.on('response', (res) => {
        job.head = {
            status: res.statusCode || 502,
            statusText: String(res.statusMessage || '').replace(/[^\t\x20-\x7e]/g, ''),
            contentType: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null,
        };
        job.headAt = Date.now();
        notify(job);
        res.on('data', chunk => append(job, chunk));
        res.on('end', () => finish(job, 'done'));
        res.on('error', error => finish(job, 'error', error.message));
        res.on('close', () => {
            if (!res.complete) finish(job, job.upstream === null && job.state === 'running' ? 'aborted' : 'error', 'connection closed');
        });
    });
    upstream.on('error', (error) => finish(job, job.state === 'running' && job.upstream === null ? 'aborted' : 'error', error.message));
    upstream.end(body);
}

/** 找到 offset 所在的分块位置 */
function locate(job, offset) {
    let pos = 0;
    for (let i = 0; i < job.chunks.length; i++) {
        const len = job.chunks[i].length;
        if (offset < pos + len) return { index: i, inner: offset - pos };
        pos += len;
    }
    return { index: job.chunks.length, inner: 0 };
}

/**
 * 把任务从 offset 开始的字节写给客户端，并持续推送新数据直到任务结束。
 */
function serveStream(job, req, res, offset) {
    let closed = false;
    let cursor = null;
    let waitingDrain = false;

    const cleanup = () => {
        if (closed) return;
        closed = true;
        job.listeners.delete(onUpdate);
        if (job.attached.delete(res)) job.lastDetachAt = Date.now();
    };
    res.on('close', cleanup);
    req.on('aborted', cleanup);

    const sendHead = () => {
        // 和 SillyTavern 原生的流式响应一样不带 Content-Type（原生响应能顺畅穿过 nginx / Cloudflare）
        res.status(200);
        res.set({
            'Cache-Control': 'no-cache, no-store, no-transform',
            'X-Accel-Buffering': 'no',
            'X-BG-Job': job.id,
            'X-BG-Status': String(job.head.status),
            'X-BG-Status-Text': encodeURIComponent(job.head.statusText || ''),
            'X-BG-Content-Type': encodeURIComponent(job.head.contentType || ''),
        });
        res.flushHeaders();
        cursor = locate(job, offset);
    };

    const pump = () => {
        if (closed || waitingDrain) return;
        if (!cursor) {
            if (!job.head) return;
            sendHead();
        }
        while (cursor.index < job.chunks.length) {
            const chunk = job.chunks[cursor.index];
            const slice = cursor.inner ? chunk.subarray(cursor.inner) : chunk;
            cursor.index++;
            cursor.inner = 0;
            if (!res.write(slice)) {
                waitingDrain = true;
                res.once('drain', () => { waitingDrain = false; pump(); });
                return;
            }
        }
        if (job.state !== 'running') {
            cleanup();
            res.end();
        }
    };
    const onUpdate = () => pump();

    job.attached.add(res);
    job.listeners.add(onUpdate);
    pump();
}

function getOwnJob(req, res) {
    const handle = handleOf(req);
    if (!handle) {
        res.sendStatus(403);
        return null;
    }
    ensureUserLoaded(handle);
    const job = jobs.get(String(req.params.id));
    if (!job || job.handle !== handle) {
        res.status(404).json({ error: 'not_found' });
        return null;
    }
    return job;
}

function enforceUserLimit(handle) {
    const mains = [...jobs.values()]
        .filter(j => j.handle === handle && j.kind === 'main' && !j.acked && j.state !== 'running')
        .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
    while (mains.length > MAX_MAIN_JOBS_PER_USER) {
        const old = mains.shift();
        jobs.delete(old.id);
        unpersist(old);
    }
}

function sweep() {
    const now = Date.now();
    for (const job of jobs.values()) {
        if (job.acked && now - job.ackedAt > ACKED_GRACE_MS && job.attached.size === 0) {
            jobs.delete(job.id);
            continue;
        }
        if (job.state === 'running') {
            if (now - job.createdAt > MAX_RUNTIME_MS) {
                abortUpstream(job);
                finish(job, 'aborted', 'max runtime exceeded');
            } else if (job.kind === 'aux' && job.attached.size === 0 && now - job.lastDetachAt > AUX_DETACHED_ABORT_MS) {
                // 后台辅助请求（总结等）所在页面已经不在了，没有人会用结果：按原版行为停止以免浪费
                abortUpstream(job);
                finish(job, 'aborted', 'client gone');
            }
            continue;
        }
        const age = now - (job.finishedAt || now);
        if (job.kind === 'aux' && age > AUX_TTL_MS && job.attached.size === 0) {
            jobs.delete(job.id);
        } else if (job.kind === 'main' && age > MAIN_TTL_MS) {
            jobs.delete(job.id);
            unpersist(job);
        }
    }
}

// ------------------------------------------------------------------ routes

/**
 * @param {import('express').Router} router
 */
export async function init(router) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    sweepTimer = setInterval(sweep, 60_000);
    sweepTimer.unref?.();

    router.get('/health', (req, res) => {
        res.json({ ok: true, version: VERSION, user: handleOf(req) });
    });

    router.post('/start', (req, res) => {
        const handle = handleOf(req);
        if (!handle) return res.sendStatus(403);
        const { id, target, meta, payload } = req.body || {};
        if (!validId(id) || !ALLOWED_TARGETS.has(target) || !payload || typeof payload !== 'object') {
            return res.status(400).json({ error: 'bad_request' });
        }
        ensureUserLoaded(handle);
        let job = jobs.get(id);
        if (job) {
            // 同一个任务的重试（首个请求的响应在路上丢了）：直接接上
            if (job.handle !== handle) return res.status(409).json({ error: 'conflict' });
        } else {
            job = newJob({ id, handle, meta, target });
            jobs.set(id, job);
            try {
                startUpstream(job, req, payload);
            } catch (error) {
                finish(job, 'error', error.message);
            }
            if (job.kind === 'main') enforceUserLimit(handle);
        }
        serveStream(job, req, res, 0);
    });

    router.get('/stream/:id', (req, res) => {
        const job = getOwnJob(req, res);
        if (!job) return;
        const client = typeof req.query.client === 'string' ? req.query.client : '';
        if (client && job.owner && client !== job.owner) {
            return res.status(409).json({ error: 'claimed', owner: job.owner });
        }
        const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0);
        if (offset > job.length) return res.status(416).json({ error: 'bad_offset', length: job.length });
        if (client && !job.owner) job.owner = client;
        serveStream(job, req, res, offset);
    });

    router.get('/status/:id', (req, res) => {
        const job = getOwnJob(req, res);
        if (!job) return;
        const status = publicStatus(job);
        delete status.meta;
        res.json(status);
    });

    router.get('/jobs', (req, res) => {
        const handle = handleOf(req);
        if (!handle) return res.sendStatus(403);
        ensureUserLoaded(handle);
        const list = [...jobs.values()]
            .filter(j => j.handle === handle && j.kind === 'main' && !j.acked && j.state !== 'aborted')
            .sort((a, b) => a.createdAt - b.createdAt)
            .map(publicStatus);
        res.json({ now: Date.now(), jobs: list });
    });

    router.post('/claim/:id', (req, res) => {
        const job = getOwnJob(req, res);
        if (!job) return;
        const client = String(req.body?.client || '');
        if (!client) return res.status(400).json({ error: 'bad_request' });
        if (job.acked) return res.status(410).json({ error: 'acked' });
        if (job.owner === client) {
            job.claimedAt = Date.now();
            return res.json({ ok: true });
        }
        // 另一个页面刚接手（正在写入）：不要重复写
        if (job.claimedAt && Date.now() - job.claimedAt < 120_000) {
            return res.status(409).json({ error: 'claimed' });
        }
        const finishedLongAgo = job.state !== 'running' && Date.now() - (job.finishedAt || 0) > 20_000;
        if (job.attached.size > 0 && !finishedLongAgo) {
            return res.status(409).json({ error: 'attached', attached: job.attached.size });
        }
        job.owner = client;
        job.claimedAt = Date.now();
        // 旧页面可能还挂着半死的连接：结束它们，让它们去确认归属
        for (const r of [...job.attached]) {
            try { r.end(); } catch { /* ignore */ }
        }
        res.json({ ok: true });
    });

    router.post('/ack/:id', (req, res) => {
        const job = getOwnJob(req, res);
        if (!job) return;
        job.acked = true;
        job.ackedAt = Date.now();
        unpersist(job);
        res.json({ ok: true });
    });

    router.post('/abort/:id', (req, res) => {
        const job = getOwnJob(req, res);
        if (!job) return;
        if (job.state === 'running') {
            abortUpstream(job);
            finish(job, 'aborted', 'aborted by user');
        }
        job.acked = true;
        job.ackedAt = Date.now();
        unpersist(job);
        res.json({ ok: true });
    });

    console.log(`${LOG} v${VERSION} ready (data: ${DATA_DIR})`);
}

export async function exit() {
    clearInterval(sweepTimer);
}

export default { info, init, exit };
