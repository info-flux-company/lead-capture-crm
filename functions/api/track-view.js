/**
 * ============================================================================
 * Cloudflare Pages Function: /api/track-view
 * ============================================================================
 * Secure server-side page view telemetry collector.
 * - Extracts genuine client geolocation strictly from Cloudflare `request.cf`.
 * - Enforces strict CORS allowlist (never Access-Control-Allow-Origin: *).
 * - Resolves published landing pages server-side and writes to Supabase using
 *   `context.env.SUPABASE_SERVICE_ROLE_KEY` (never exposed to clients).
 * ============================================================================
 */

const MAX_BODY_BYTES = 4096;
const SLUG_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const ALLOWED_KEYS = new Set(['page_slug', 'utm_source', 'device']);
const ALLOWED_DEVICES = new Set(['mobile', 'tablet', 'desktop', 'other']);
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/g;

/**
 * Encapsulates CORS validation, payload validation, geo extraction, and
 * Supabase PostgREST persistence for page view tracking.
 */
export class ViewTrackerHandler {
    /** @type {Request} */
    #request;

    /** @type {Record<string, string | undefined>} */
    #env;

    /**
     * @param {{ request: Request, env: Record<string, string | undefined> }} context
     */
    constructor(context) {
        this.#request = context.request;
        this.#env = context.env || {};
    }

    /**
     * Handles CORS preflight OPTIONS requests.
     * @returns {Response}
     */
    handleOptions() {
        const cors = this.#resolveCorsHeaders();
        if (!cors.allowed) {
            return this.#jsonResponse(403, { ok: false, error: 'Origin not allowed.' }, cors.headers);
        }

        return new Response(null, {
            status: 204,
            headers: {
                ...cors.headers,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff'
            }
        });
    }

    /**
     * Rejects unsupported HTTP methods with 405 Method Not Allowed.
     * @returns {Response}
     */
    handleMethodNotAllowed() {
        const cors = this.#resolveCorsHeaders();
        return this.#jsonResponse(
            405,
            { ok: false, error: 'Method not allowed.' },
            {
                ...cors.headers,
                Allow: 'POST, OPTIONS'
            }
        );
    }

    /**
     * Validates and logs an incoming page view event.
     * @returns {Promise<Response>}
     */
    async handlePost() {
        const cors = this.#resolveCorsHeaders();
        if (!cors.allowed) {
            return this.#jsonResponse(403, { ok: false, error: 'Origin not allowed.' }, cors.headers);
        }

        const config = this.#validateSupabaseConfig();
        if (!config.ok) {
            console.error('[track-view] Missing or invalid SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
            return this.#jsonResponse(
                500,
                { ok: false, error: 'Server configuration error.' },
                cors.headers
            );
        }

        const contentTypeHeader = this.#request.headers.get('Content-Type') || '';
        const mediaType = contentTypeHeader.split(';')[0].trim().toLowerCase();
        if (mediaType !== 'application/json' && mediaType !== 'text/plain') {
            return this.#jsonResponse(
                415,
                { ok: false, error: 'Unsupported Media Type. Expected application/json.' },
                cors.headers
            );
        }

        const contentLengthHeader = this.#request.headers.get('Content-Length');
        if (contentLengthHeader !== null) {
            const declaredLength = Number(contentLengthHeader);
            if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
                return this.#jsonResponse(
                    413,
                    { ok: false, error: 'Payload too large.' },
                    cors.headers
                );
            }
        }

        let rawBody = '';
        try {
            rawBody = await this.#request.text();
        } catch {
            return this.#jsonResponse(
                400,
                { ok: false, error: 'Unable to read request body.' },
                cors.headers
            );
        }

        const actualBytes = new TextEncoder().encode(rawBody).length;
        if (actualBytes > MAX_BODY_BYTES) {
            return this.#jsonResponse(
                413,
                { ok: false, error: 'Payload too large.' },
                cors.headers
            );
        }

        let payload;
        try {
            payload = JSON.parse(rawBody);
        } catch {
            return this.#jsonResponse(
                400,
                { ok: false, error: 'Invalid JSON payload.' },
                cors.headers
            );
        }

        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
            return this.#jsonResponse(
                400,
                { ok: false, error: 'Request body must be a JSON object.' },
                cors.headers
            );
        }

        for (const key of Object.keys(payload)) {
            if (!ALLOWED_KEYS.has(key)) {
                return this.#jsonResponse(
                    400,
                    { ok: false, error: `Unknown field: ${key}` },
                    cors.headers
                );
            }
        }

        if (typeof payload.page_slug !== 'string') {
            return this.#jsonResponse(
                400,
                { ok: false, error: 'Invalid or missing page_slug.' },
                cors.headers
            );
        }

        const pageSlug = payload.page_slug.trim();
        if (!SLUG_REGEX.test(pageSlug)) {
            return this.#jsonResponse(
                400,
                { ok: false, error: 'Invalid page_slug format.' },
                cors.headers
            );
        }

        let utmSource = 'direct';
        if (payload.utm_source !== undefined && payload.utm_source !== null) {
            if (typeof payload.utm_source !== 'string') {
                return this.#jsonResponse(
                    400,
                    { ok: false, error: 'utm_source must be a string.' },
                    cors.headers
                );
            }
            const sanitizedUtm = this.#sanitizeText(payload.utm_source, 100);
            if (sanitizedUtm.length > 0) {
                utmSource = sanitizedUtm;
            }
        }

        let device = '';
        if (payload.device !== undefined && payload.device !== null) {
            if (typeof payload.device !== 'string') {
                return this.#jsonResponse(
                    400,
                    { ok: false, error: 'device must be a string.' },
                    cors.headers
                );
            }
            const normalizedDevice = this.#sanitizeText(payload.device, 20).toLowerCase();
            if (normalizedDevice.length > 0) {
                if (!ALLOWED_DEVICES.has(normalizedDevice)) {
                    return this.#jsonResponse(
                        400,
                        { ok: false, error: 'Invalid device value.' },
                        cors.headers
                    );
                }
                device = normalizedDevice;
            }
        }

        if (!device) {
            device = this.#detectDeviceFromUserAgent(this.#request.headers.get('User-Agent') || '');
        }

        const geo = this.#extractGeoFromCloudflare();

        try {
            const page = await this.#lookupPublishedPage(config, pageSlug);
            if (!page) {
                return this.#jsonResponse(
                    404,
                    { ok: false, error: 'Landing page not found or unpublished.' },
                    cors.headers
                );
            }

            const inserted = await this.#insertPageView(config, {
                workspace_id: page.workspace_id,
                page_id: page.id,
                country: geo.country,
                city: geo.city,
                device,
                utm_source: utmSource
            });

            if (!inserted) {
                return this.#jsonResponse(
                    500,
                    { ok: false, error: 'Failed to record page view.' },
                    cors.headers
                );
            }

            return this.#jsonResponse(201, { ok: true }, cors.headers);
        } catch (err) {
            console.error('[track-view] Unexpected error:', err instanceof Error ? err.message : err);
            return this.#jsonResponse(
                500,
                { ok: false, error: 'Internal server error.' },
                cors.headers
            );
        }
    }

    /**
     * Resolves strict CORS headers against ALLOWED_ORIGINS and same-origin rules.
     * @returns {{ allowed: boolean, headers: Record<string, string> }}
     */
    #resolveCorsHeaders() {
        const originHeader = this.#request.headers.get('Origin');
        if (!originHeader) {
            return {
                allowed: true,
                headers: { Vary: 'Origin' }
            };
        }

        const normalizedOrigin = this.#normalizeOrigin(originHeader);
        if (!normalizedOrigin) {
            return {
                allowed: false,
                headers: { Vary: 'Origin' }
            };
        }

        let requestUrl;
        try {
            requestUrl = new URL(this.#request.url);
        } catch {
            return {
                allowed: false,
                headers: { Vary: 'Origin' }
            };
        }

        const allowedSet = this.#parseAllowedOrigins();
        const isSameOrigin = normalizedOrigin === requestUrl.origin;
        const isConfiguredOrigin = allowedSet.has(normalizedOrigin);

        const isFunctionLocal =
            requestUrl.hostname === 'localhost' || requestUrl.hostname === '127.0.0.1';
        let isLocalOrigin = false;
        if (isFunctionLocal) {
            try {
                const parsedOrigin = new URL(normalizedOrigin);
                isLocalOrigin =
                    parsedOrigin.protocol === 'http:' &&
                    (parsedOrigin.hostname === 'localhost' || parsedOrigin.hostname === '127.0.0.1');
            } catch {
                isLocalOrigin = false;
            }
        }

        if (isSameOrigin || isConfiguredOrigin || isLocalOrigin) {
            return {
                allowed: true,
                headers: {
                    'Access-Control-Allow-Origin': normalizedOrigin,
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Access-Control-Max-Age': '86400',
                    Vary: 'Origin'
                }
            };
        }

        return {
            allowed: false,
            headers: { Vary: 'Origin' }
        };
    }

    /**
     * Parses comma-separated ALLOWED_ORIGINS env var into normalized origin strings.
     * @returns {Set<string>}
     */
    #parseAllowedOrigins() {
        const raw = typeof this.#env.ALLOWED_ORIGINS === 'string' ? this.#env.ALLOWED_ORIGINS : '';
        const set = new Set();
        for (const entry of raw.split(',')) {
            const normalized = this.#normalizeOrigin(entry);
            if (normalized) {
                set.add(normalized);
            }
        }
        return set;
    }

    /**
     * Normalizes an origin string to scheme://host[:port].
     * @param {string} value
     * @returns {string | null}
     */
    #normalizeOrigin(value) {
        const trimmed = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
        if (!trimmed || trimmed === '*') {
            return null;
        }
        try {
            const parsed = new URL(trimmed);
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
                return null;
            }
            return parsed.origin;
        } catch {
            return null;
        }
    }

    /**
     * Validates server-side Supabase configuration.
     * @returns {{ ok: true, supabaseOrigin: string, serviceRoleKey: string } | { ok: false }}
     */
    #validateSupabaseConfig() {
        const rawUrl = typeof this.#env.SUPABASE_URL === 'string' ? this.#env.SUPABASE_URL.trim() : '';
        const serviceRoleKey =
            typeof this.#env.SUPABASE_SERVICE_ROLE_KEY === 'string'
                ? this.#env.SUPABASE_SERVICE_ROLE_KEY.trim()
                : '';

        if (!rawUrl || !serviceRoleKey) {
            return { ok: false };
        }

        try {
            const parsed = new URL(rawUrl);
            const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
            const validProtocol =
                parsed.protocol === 'https:' || (isLocal && parsed.protocol === 'http:');
            if (!validProtocol) {
                return { ok: false };
            }
            return { ok: true, supabaseOrigin: parsed.origin, serviceRoleKey };
        } catch {
            return { ok: false };
        }
    }

    /**
     * Strips control characters and caps length.
     * @param {string} value
     * @param {number} maxLength
     * @returns {string}
     */
    #sanitizeText(value, maxLength) {
        return value.replace(CONTROL_CHARS_REGEX, '').trim().slice(0, maxLength);
    }

    /**
     * Detects client device type from User-Agent when not explicitly supplied.
     * @param {string} userAgent
     * @returns {'mobile' | 'tablet' | 'desktop' | 'other'}
     */
    #detectDeviceFromUserAgent(userAgent) {
        if (!userAgent) {
            return 'other';
        }
        if (/(ipad|tablet|playbook|silk)|(android(?!.*mobile))/i.test(userAgent)) {
            return 'tablet';
        }
        if (/mobile|iphone|ipod|android|blackberry|iemobile|opera mini|windows phone/i.test(userAgent)) {
            return 'mobile';
        }
        if (/windows nt|macintosh|linux|x11|cros/i.test(userAgent)) {
            return 'desktop';
        }
        return 'other';
    }

    /**
     * Extracts real country & city strictly from Cloudflare's edge `request.cf` object.
     * @returns {{ country: string, city: string }}
     */
    #extractGeoFromCloudflare() {
        const cf = this.#request.cf;
        const rawCountry = typeof cf?.country === 'string' ? this.#sanitizeText(cf.country, 64) : '';
        const rawCity = typeof cf?.city === 'string' ? this.#sanitizeText(cf.city, 100) : '';

        return {
            country: rawCountry || 'Unknown',
            city: rawCity || 'Unknown'
        };
    }

    /**
     * Fetches the published landing page matching `slug` via Supabase PostgREST.
     * @param {{ supabaseOrigin: string, serviceRoleKey: string }} config
     * @param {string} slug
     * @returns {Promise<{ id: string, workspace_id: string, is_published: boolean } | null>}
     */
    async #lookupPublishedPage(config, slug) {
        const endpoint = `${config.supabaseOrigin}/rest/v1/pages?select=id,workspace_id,is_published&slug=eq.${encodeURIComponent(
            slug
        )}&limit=1`;

        const res = await fetch(endpoint, {
            method: 'GET',
            headers: {
                apikey: config.serviceRoleKey,
                Authorization: `Bearer ${config.serviceRoleKey}`,
                Accept: 'application/json'
            }
        });

        if (!res.ok) {
            console.error(`[track-view] Supabase page lookup failed with status ${res.status}.`);
            throw new Error('Supabase lookup failed');
        }

        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length === 0) {
            return null;
        }

        const page = rows[0];
        if (!page || page.is_published !== true || !page.id || !page.workspace_id) {
            return null;
        }

        return page;
    }

    /**
     * Inserts a page_view record into Supabase using service_role credentials.
     * @param {{ supabaseOrigin: string, serviceRoleKey: string }} config
     * @param {Record<string, unknown>} record
     * @returns {Promise<boolean>}
     */
    async #insertPageView(config, record) {
        const endpoint = `${config.supabaseOrigin}/rest/v1/page_views`;

        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                apikey: config.serviceRoleKey,
                Authorization: `Bearer ${config.serviceRoleKey}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal'
            },
            body: JSON.stringify(record)
        });

        if (!res.ok) {
            console.error(`[track-view] Supabase page_views insert failed with status ${res.status}.`);
            return false;
        }

        return true;
    }

    /**
     * Builds a hardened JSON HTTP response.
     * @param {number} status
     * @param {Record<string, unknown>} body
     * @param {Record<string, string>} extraHeaders
     * @returns {Response}
     */
    #jsonResponse(status, body, extraHeaders = {}) {
        return new Response(JSON.stringify(body), {
            status,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                Vary: 'Origin',
                ...extraHeaders
            }
        });
    }
}

/**
 * Cloudflare Pages Function handler for OPTIONS preflight.
 * @param {{ request: Request, env: Record<string, string | undefined> }} context
 * @returns {Response}
 */
export async function onRequestOptions(context) {
    return new ViewTrackerHandler(context).handleOptions();
}

/**
 * Cloudflare Pages Function handler for POST /api/track-view.
 * @param {{ request: Request, env: Record<string, string | undefined> }} context
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
    return new ViewTrackerHandler(context).handlePost();
}

/**
 * Fallback handler rejecting all non-POST/OPTIONS HTTP verbs.
 * @param {{ request: Request, env: Record<string, string | undefined> }} context
 * @returns {Response}
 */
export async function onRequest(context) {
    return new ViewTrackerHandler(context).handleMethodNotAllowed();
}
