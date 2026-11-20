/**
 * ============================================================================
 * Cloudflare Pages Function: /api/submit-lead
 * ============================================================================
 * Secure server-side B2B lead capture endpoint.
 * - Enforces strict CORS allowlist (never Access-Control-Allow-Origin: *).
 * - Applies per-IP sliding-window rate limiting inside the Worker isolate
 *   (Note: Also configure a Cloudflare WAF Rate Limiting Rule on
 *   /api/submit-lead in production for global multi-PoP enforcement).
 * - Enforces strict JSON schema & rejects unknown/spoofed fields.
 * - Silently drops spam bots via the hidden `website_url` honeypot field.
 * - Validates and normalizes Arabic/Latin names and phone numbers.
 * - Extracts geolocation strictly from Cloudflare `request.cf`.
 * - Inserts leads via Supabase PostgREST using `SUPABASE_SERVICE_ROLE_KEY`.
 * ============================================================================
 */

const MAX_BODY_BYTES = 8192;
const SLUG_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const PHONE_CHAR_REGEX = /^\+?[\d\s().-]{7,25}$/;
const REPEATED_DIGITS_REGEX = /^(\d)\1{6,}$/;
const HAS_LETTER_REGEX = /\p{L}/u;
const ALLOWED_KEYS = new Set([
    'page_slug',
    'name',
    'phone',
    'utm_source',
    'notes',
    'website_url'
]);
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/g;
const NOTES_CONTROL_CHARS_REGEX = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

const DEFAULT_RATE_LIMIT_MAX = 5;
const DEFAULT_RATE_LIMIT_WINDOW_SEC = 60;
const MAX_TRACKED_KEYS = 1000;

/**
 * Bounded in-isolate sliding-window rate limiter keyed by client IP.
 * Keeps memory usage strictly capped to MAX_TRACKED_KEYS entries.
 */
export class EdgeRateLimiter {
    /** @type {Map<string, number[]>} */
    static #store = new Map();

    /**
     * Checks and records a request attempt for `ipKey`.
     * @param {string} ipKey
     * @param {Record<string, string | undefined>} env
     * @param {number} [nowMs]
     * @returns {{ allowed: boolean, limit: number, remaining: number, resetSeconds: number, retryAfterSeconds: number }}
     */
    consume(ipKey, env = {}, nowMs = Date.now()) {
        const limit = this.#parsePositiveInt(env.RATE_LIMIT_MAX_REQUESTS, DEFAULT_RATE_LIMIT_MAX);
        const windowSec = this.#parsePositiveInt(
            env.RATE_LIMIT_WINDOW_SECONDS,
            DEFAULT_RATE_LIMIT_WINDOW_SEC
        );
        const windowMs = windowSec * 1000;

        const existing = EdgeRateLimiter.#store.get(ipKey) || [];
        const activeTimestamps = existing.filter((ts) => nowMs - ts < windowMs);

        if (activeTimestamps.length >= limit) {
            // Refresh entry with pruned timestamps
            EdgeRateLimiter.#store.delete(ipKey);
            EdgeRateLimiter.#store.set(ipKey, activeTimestamps);

            const oldestTs = activeTimestamps[0];
            const retryAfterMs = Math.max(1000, oldestTs + windowMs - nowMs);
            const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

            return {
                allowed: false,
                limit,
                remaining: 0,
                resetSeconds: retryAfterSeconds,
                retryAfterSeconds
            };
        }

        if (!EdgeRateLimiter.#store.has(ipKey)) {
            while (EdgeRateLimiter.#store.size >= MAX_TRACKED_KEYS) {
                const oldestKey = EdgeRateLimiter.#store.keys().next().value;
                if (oldestKey === undefined) {
                    break;
                }
                EdgeRateLimiter.#store.delete(oldestKey);
            }
        }

        activeTimestamps.push(nowMs);
        EdgeRateLimiter.#store.delete(ipKey);
        EdgeRateLimiter.#store.set(ipKey, activeTimestamps);

        const oldestTs = activeTimestamps[0];
        const resetSeconds = Math.max(1, Math.ceil((oldestTs + windowMs - nowMs) / 1000));

        return {
            allowed: true,
            limit,
            remaining: Math.max(0, limit - activeTimestamps.length),
            resetSeconds,
            retryAfterSeconds: 0
        };
    }

    /**
     * Parses a positive integer configuration value with safe fallback.
     * @param {string | undefined} raw
     * @param {number} fallback
     * @returns {number}
     */
    #parsePositiveInt(raw, fallback) {
        if (typeof raw !== 'string' || !raw.trim()) {
            return fallback;
        }
        const parsed = Number.parseInt(raw.trim(), 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }
}

const sharedRateLimiter = new EdgeRateLimiter();

/**
 * Handles secure B2B lead submission, validation, anti-spam protection,
 * server-side geo resolution, and Supabase persistence.
 */
export class LeadSubmissionHandler {
    /** @type {Request} */
    #request;

    /** @type {Record<string, string | undefined>} */
    #env;

    /** @type {EdgeRateLimiter} */
    #rateLimiter;

    /**
     * @param {{ request: Request, env: Record<string, string | undefined> }} context
     * @param {EdgeRateLimiter} [rateLimiter]
     */
    constructor(context, rateLimiter = sharedRateLimiter) {
        this.#request = context.request;
        this.#env = context.env || {};
        this.#rateLimiter = rateLimiter;
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
     * Processes an incoming lead form submission with layered security checks.
     * @returns {Promise<Response>}
     */
    async handlePost() {
        // Step A: Strict CORS Check
        const cors = this.#resolveCorsHeaders();
        if (!cors.allowed) {
            return this.#jsonResponse(403, { ok: false, error: 'Origin not allowed.' }, cors.headers);
        }

        // Step B: Per-IP Rate Limiting
        const clientIp = this.#extractClientIp();
        const rate = this.#rateLimiter.consume(clientIp, this.#env);
        const rateHeaders = {
            ...cors.headers,
            'X-RateLimit-Limit': String(rate.limit),
            'X-RateLimit-Remaining': String(rate.remaining),
            'X-RateLimit-Reset': String(rate.resetSeconds)
        };

        if (!rate.allowed) {
            return this.#jsonResponse(
                429,
                {
                    ok: false,
                    error: 'لقد تجاوزت الحد المسموح به من الطلبات. يرجى المحاولة بعد دقيقة.'
                },
                {
                    ...rateHeaders,
                    'Retry-After': String(rate.retryAfterSeconds)
                }
            );
        }

        // Step C: Server Configuration Check
        const config = this.#validateSupabaseConfig();
        if (!config.ok) {
            console.error('[submit-lead] Missing or invalid SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
            return this.#jsonResponse(
                500,
                { ok: false, error: 'حدث خطأ في إعدادات الخادم.' },
                rateHeaders
            );
        }

        // Step D: Strict Content-Type & Body Size Guard
        const contentTypeHeader = this.#request.headers.get('Content-Type') || '';
        const mediaType = contentTypeHeader.split(';')[0].trim().toLowerCase();
        if (mediaType !== 'application/json') {
            return this.#jsonResponse(
                415,
                { ok: false, error: 'Unsupported Media Type. Expected application/json.' },
                rateHeaders
            );
        }

        const contentLengthHeader = this.#request.headers.get('Content-Length');
        if (contentLengthHeader !== null) {
            const declaredLength = Number(contentLengthHeader);
            if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
                return this.#jsonResponse(
                    413,
                    { ok: false, error: 'حجم البيانات المرسلة يتجاوز الحد المسموح.' },
                    rateHeaders
                );
            }
        }

        let rawBody = '';
        try {
            rawBody = await this.#request.text();
        } catch {
            return this.#jsonResponse(
                400,
                { ok: false, error: 'تعذر قراءة بيانات الطلب.' },
                rateHeaders
            );
        }

        const actualBytes = new TextEncoder().encode(rawBody).length;
        if (actualBytes > MAX_BODY_BYTES) {
            return this.#jsonResponse(
                413,
                { ok: false, error: 'حجم البيانات المرسلة يتجاوز الحد المسموح.' },
                rateHeaders
            );
        }

        // Step E: Strict JSON Schema & Unknown-Key Rejection
        let payload;
        try {
            payload = JSON.parse(rawBody);
        } catch {
            return this.#jsonResponse(
                400,
                { ok: false, error: 'صيغة JSON غير صالحة.' },
                rateHeaders
            );
        }

        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
            return this.#jsonResponse(
                400,
                { ok: false, error: 'يجب أن يكون جسم الطلب كائن JSON صالح.' },
                rateHeaders
            );
        }

        for (const key of Object.keys(payload)) {
            if (!ALLOWED_KEYS.has(key)) {
                return this.#jsonResponse(
                    400,
                    { ok: false, error: `حقل غير مسموح به: ${key}` },
                    rateHeaders
                );
            }
        }

        // Step F: Hidden Honeypot Check (silently drop bots without touching DB)
        if (payload.website_url !== undefined && payload.website_url !== null) {
            const trapValue =
                typeof payload.website_url === 'string'
                    ? payload.website_url.trim()
                    : String(payload.website_url).trim();
            if (trapValue.length > 0) {
                return this.#jsonResponse(
                    200,
                    { ok: true, message: 'تم استلام طلبك بنجاح.' },
                    rateHeaders
                );
            }
        }

        // Step G: Field-Level Validation & Normalization
        const validation = this.#validateAndNormalizeFields(payload);
        if (!validation.ok) {
            return this.#jsonResponse(
                400,
                {
                    ok: false,
                    error: 'بيانات الطلب غير مكتملة أو غير صالحة.',
                    fields: validation.fields
                },
                rateHeaders
            );
        }

        const { pageSlug, name, phone, utmSource, notes } = validation.data;

        try {
            // Step H: Server-Side Published Page Resolution
            const page = await this.#lookupPublishedPage(config, pageSlug);
            if (!page) {
                return this.#jsonResponse(
                    404,
                    { ok: false, error: 'صفحة الهبوط المطلوبة غير موجودة أو غير منشورة.' },
                    rateHeaders
                );
            }

            // Step I: Server-Side Geo Extraction (never trust client geo headers/fields)
            const geo = this.#extractGeoFromCloudflare();

            // Step J: Persist Lead in Supabase via service_role
            const inserted = await this.#insertLead(config, {
                workspace_id: page.workspace_id,
                page_id: page.id,
                name,
                phone,
                city: geo.city,
                country: geo.country,
                utm_source: utmSource,
                status: 'new',
                notes
            });

            if (!inserted) {
                return this.#jsonResponse(
                    500,
                    { ok: false, error: 'تعذر حفظ الطلب حالياً. يرجى المحاولة مرة أخرى.' },
                    rateHeaders
                );
            }

            return this.#jsonResponse(
                201,
                { ok: true, message: 'تم استلام طلبك بنجاح.' },
                rateHeaders
            );
        } catch (err) {
            console.error('[submit-lead] Unexpected error:', err instanceof Error ? err.message : err);
            return this.#jsonResponse(
                500,
                { ok: false, error: 'حدث خطأ غير متوقع في الخادم.' },
                rateHeaders
            );
        }
    }

    /**
     * Validates and normalizes `page_slug`, `name`, `phone`, `utm_source`, and `notes`.
     * @param {Record<string, unknown>} payload
     * @returns {{ ok: true, data: { pageSlug: string, name: string, phone: string, utmSource: string, notes: string } } | { ok: false, fields: Record<string, string> }}
     */
    #validateAndNormalizeFields(payload) {
        /** @type {Record<string, string>} */
        const fields = {};

        // page_slug
        let pageSlug = '';
        if (typeof payload.page_slug !== 'string') {
            fields.page_slug = 'معرف الصفحة مطلوب.';
        } else {
            pageSlug = payload.page_slug.trim();
            if (!SLUG_REGEX.test(pageSlug)) {
                fields.page_slug = 'صيغة معرف الصفحة غير صالحة.';
            }
        }

        // name
        let cleanName = '';
        if (typeof payload.name !== 'string') {
            fields.name = 'الاسم الكامل مطلوب.';
        } else {
            cleanName = payload.name
                .replace(CONTROL_CHARS_REGEX, '')
                .replace(/\s+/g, ' ')
                .trim();
            if (cleanName.length < 2 || cleanName.length > 150 || !HAS_LETTER_REGEX.test(cleanName)) {
                fields.name = 'يرجى إدخال اسم صحيح (من 2 إلى 150 حرفاً).';
            }
        }

        // phone
        let cleanPhone = '';
        if (typeof payload.phone !== 'string') {
            fields.phone = 'رقم الهاتف مطلوب.';
        } else {
            const asciiPhone = this.#normalizeArabicDigits(payload.phone).trim();
            if (!PHONE_CHAR_REGEX.test(asciiPhone)) {
                fields.phone = 'يرجى إدخال رقم هاتف صحيح.';
            } else {
                const hasPlus = asciiPhone.startsWith('+');
                const digitsOnly = asciiPhone.replace(/\D/g, '');
                if (
                    digitsOnly.length < 7 ||
                    digitsOnly.length > 15 ||
                    REPEATED_DIGITS_REGEX.test(digitsOnly)
                ) {
                    fields.phone = 'رقم الهاتف يجب أن يتكون من 7 إلى 15 رقماً صحيحاً.';
                } else {
                    cleanPhone = hasPlus ? `+${digitsOnly}` : digitsOnly;
                }
            }
        }

        // utm_source (optional, defaults to 'direct')
        let utmSource = 'direct';
        if (payload.utm_source !== undefined && payload.utm_source !== null) {
            if (typeof payload.utm_source !== 'string') {
                fields.utm_source = 'مصدر الزيارة يجب أن يكون نصاً.';
            } else {
                const sanitizedUtm = payload.utm_source
                    .replace(CONTROL_CHARS_REGEX, '')
                    .trim()
                    .slice(0, 100);
                if (sanitizedUtm.length > 0) {
                    utmSource = sanitizedUtm;
                }
            }
        }

        // notes (optional, defaults to '')
        let notes = '';
        if (payload.notes !== undefined && payload.notes !== null) {
            if (typeof payload.notes !== 'string') {
                fields.notes = 'الملاحظات يجب أن تكون نصاً.';
            } else {
                notes = payload.notes
                    .replace(/\r\n/g, '\n')
                    .replace(NOTES_CONTROL_CHARS_REGEX, '')
                    .trim();
                if (notes.length > 1000) {
                    fields.notes = 'الملاحظات يجب ألا تتجاوز 1000 حرف.';
                }
            }
        }

        if (Object.keys(fields).length > 0) {
            return { ok: false, fields };
        }

        return {
            ok: true,
            data: {
                pageSlug,
                name: cleanName,
                phone: cleanPhone,
                utmSource,
                notes
            }
        };
    }

    /**
     * Converts Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits to ASCII 0-9.
     * @param {string} input
     * @returns {string}
     */
    #normalizeArabicDigits(input) {
        return input
            .replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660))
            .replace(/[\u06F0-\u06F9]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0));
    }

    /**
     * Extracts client IP from Cloudflare connecting headers for rate limiting.
     * @returns {string}
     */
    #extractClientIp() {
        const cfIp = this.#request.headers.get('CF-Connecting-IP');
        if (cfIp && cfIp.trim()) {
            return cfIp.trim();
        }
        const forwardedFor = this.#request.headers.get('X-Forwarded-For');
        if (forwardedFor && forwardedFor.trim()) {
            const firstIp = forwardedFor.split(',')[0].trim();
            if (firstIp) {
                return firstIp;
            }
        }
        return 'unknown';
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
     * Extracts real country & city strictly from Cloudflare's edge `request.cf` object.
     * @returns {{ country: string, city: string }}
     */
    #extractGeoFromCloudflare() {
        const cf = this.#request.cf;
        const rawCountry =
            typeof cf?.country === 'string'
                ? cf.country.replace(CONTROL_CHARS_REGEX, '').trim().slice(0, 64)
                : '';
        const rawCity =
            typeof cf?.city === 'string'
                ? cf.city.replace(CONTROL_CHARS_REGEX, '').trim().slice(0, 100)
                : '';

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
            console.error(`[submit-lead] Supabase page lookup failed with status ${res.status}.`);
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
     * Inserts a validated lead record into Supabase using service_role credentials.
     * @param {{ supabaseOrigin: string, serviceRoleKey: string }} config
     * @param {Record<string, unknown>} record
     * @returns {Promise<boolean>}
     */
    async #insertLead(config, record) {
        const endpoint = `${config.supabaseOrigin}/rest/v1/leads`;

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
            console.error(`[submit-lead] Supabase lead insert failed with status ${res.status}.`);
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
    return new LeadSubmissionHandler(context).handleOptions();
}

/**
 * Cloudflare Pages Function handler for POST /api/submit-lead.
 * @param {{ request: Request, env: Record<string, string | undefined> }} context
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
    return new LeadSubmissionHandler(context).handlePost();
}

/**
 * Universal dispatcher ensuring proper routing under all Cloudflare runtimes.
 * @param {{ request: Request, env: Record<string, string | undefined> }} context
 * @returns {Promise<Response>}
 */
export async function onRequest(context) {
    const method = (context.request.method || '').toUpperCase();
    const handler = new LeadSubmissionHandler(context);
    if (method === 'POST') {
        return handler.handlePost();
    }
    if (method === 'OPTIONS') {
        return handler.handleOptions();
    }
    return handler.handleMethodNotAllowed();
}
