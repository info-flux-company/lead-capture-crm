/**
 * ============================================================================
 * Singleton Supabase Client Manager
 * ============================================================================
 * Initializes and validates the browser-safe Supabase client using public
 * credentials from js/config.js. Enforces strict client-side guards to prevent
 * accidental exposure of a Supabase service_role key in the browser.
 * ============================================================================
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import APP_CONFIG from './config.js';

/**
 * Manages the single shared Supabase client instance across all services.
 */
export class SupabaseClientManager {
    /** @type {SupabaseClientManager | null} */
    static #instance = null;

    /** @type {symbol} */
    static #constructorToken = Symbol('SupabaseClientManagerToken');

    /** @type {import('@supabase/supabase-js').SupabaseClient | null} */
    #client = null;

    /** @type {string | null} */
    #configError = null;

    /** @type {boolean} */
    #initialized = false;

    /**
     * Private-guarded constructor. Use SupabaseClientManager.getInstance().
     * @param {symbol} token
     */
    constructor(token) {
        if (token !== SupabaseClientManager.#constructorToken) {
            throw new Error(
                'Cannot instantiate SupabaseClientManager directly. Use SupabaseClientManager.getInstance().'
            );
        }

        this.#initialize();
    }

    /**
     * Returns the singleton SupabaseClientManager instance.
     * @returns {SupabaseClientManager}
     */
    static getInstance() {
        if (!SupabaseClientManager.#instance) {
            SupabaseClientManager.#instance = new SupabaseClientManager(
                SupabaseClientManager.#constructorToken
            );
        }
        return SupabaseClientManager.#instance;
    }

    /**
     * Validates configuration from APP_CONFIG and creates the Supabase client.
     */
    #initialize() {
        const supabaseConfig = APP_CONFIG?.supabase;
        const rawUrl = typeof supabaseConfig?.url === 'string' ? supabaseConfig.url.trim() : '';
        const rawAnonKey =
            typeof supabaseConfig?.anonKey === 'string' ? supabaseConfig.anonKey.trim() : '';

        if (!rawUrl || !rawAnonKey) {
            this.#configError =
                'بيانات الاتصال بقاعدة البيانات (Supabase URL / Anon Key) غير مكتملة في js/config.js.';
            return;
        }

        if (
            rawUrl.includes('YOUR_PROJECT_REF') ||
            rawAnonKey.includes('YOUR_SUPABASE_ANON_KEY')
        ) {
            this.#configError =
                'يرجى تحديث إعدادات Supabase في ملف js/config.js قبل تسجيل الدخول.';
            return;
        }

        let parsedUrl;
        try {
            parsedUrl = new URL(rawUrl);
        } catch {
            this.#configError = 'صيغة رابط مشروع Supabase في js/config.js غير صالحة.';
            return;
        }

        const isLocalhost =
            parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
        const isAllowedProtocol =
            parsedUrl.protocol === 'https:' || (isLocalhost && parsedUrl.protocol === 'http:');

        if (!isAllowedProtocol) {
            this.#configError =
                'يجب أن يستخدم رابط Supabase بروتوكول HTTPS لحماية الجلسات والبيانات.';
            return;
        }

        if (this.#isServiceRoleJwt(rawAnonKey)) {
            this.#configError =
                'تحذير أمني حرج: تم اكتشاف مفتاح service_role في الواجهة الأمامية! يجب استخدام مفتاح anon العام فقط في js/config.js.';
            console.error(
                '[Security Guard] Refused to initialize Supabase client with a service_role key in the browser.'
            );
            return;
        }

        const rawSlug = parsedUrl.hostname.split('.')[0] || 'workspace';
        const safeSlug = rawSlug.replace(/[^a-zA-Z0-9_-]/g, '') || 'workspace';
        const storageKey = `crm-sb-auth-${safeSlug}`;

        try {
            this.#client = createClient(parsedUrl.origin, rawAnonKey, {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    detectSessionInUrl: false,
                    storageKey
                },
                realtime: {
                    params: {
                        eventsPerSecond: 10
                    }
                }
            });
            this.#configError = null;
            this.#initialized = true;
        } catch (err) {
            this.#client = null;
            this.#initialized = false;
            this.#configError = `تعذر تهيئة عميل Supabase: ${err instanceof Error ? err.message : 'خطأ غير معروف'}`;
        }
    }

    /**
     * Decodes a JWT payload segment (if present) to verify it is NOT a service_role secret.
     * @param {string} key
     * @returns {boolean}
     */
    #isServiceRoleJwt(key) {
        const parts = key.split('.');
        if (parts.length !== 3) {
            // Non-JWT keys (e.g., sb_publishable_*) are checked by prefix
            return key.startsWith('sb_secret_');
        }

        try {
            const base64Url = parts[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');

            let jsonPayload = '';
            if (typeof atob === 'function') {
                const binary = atob(padded);
                const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
                jsonPayload = new TextDecoder().decode(bytes);
            } else if (typeof Buffer !== 'undefined') {
                jsonPayload = Buffer.from(padded, 'base64').toString('utf8');
            } else {
                return false;
            }

            const payload = JSON.parse(jsonPayload);
            return payload?.role === 'service_role';
        } catch {
            return false;
        }
    }

    /**
     * Indicates whether the Supabase client is properly configured and ready.
     * @returns {boolean}
     */
    isConfigured() {
        return this.#initialized && this.#client !== null;
    }

    /**
     * Returns the configuration validation error message, or null when configured.
     * @returns {string | null}
     */
    getConfigError() {
        return this.#configError;
    }

    /**
     * Returns the initialized Supabase client or throws a descriptive error.
     * @returns {import('@supabase/supabase-js').SupabaseClient}
     */
    getClient() {
        if (!this.isConfigured() || !this.#client) {
            throw new Error(
                this.#configError || 'لم يتم تهيئة عميل Supabase بعد. تحقق من ملف js/config.js.'
            );
        }
        return this.#client;
    }
}

export const supabaseManager = SupabaseClientManager.getInstance();

/**
 * Convenience accessor returning the singleton Supabase client instance.
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
export function getSupabaseClient() {
    return supabaseManager.getClient();
}

/**
 * Convenience helper indicating whether Supabase credentials are valid and ready.
 * @returns {boolean}
 */
export function isSupabaseConfigured() {
    return supabaseManager.isConfigured();
}

export default supabaseManager;
