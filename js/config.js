/**
 * ============================================================================
 * White-Label Configuration (Single Source of Truth)
 * ============================================================================
 * Deploy this dashboard for any new client or SaaS workspace simply by updating
 * the branding details, regional settings, and Supabase public credentials below.
 *
 * SECURITY WARNING:
 * - ONLY place your public SUPABASE_URL and SUPABASE_ANON_KEY here.
 * - NEVER place SUPABASE_SERVICE_ROLE_KEY in frontend code. The Service Role key
 *   must live exclusively in Cloudflare Pages Environment Variables
 *   (context.env.SUPABASE_SERVICE_ROLE_KEY).
 * ============================================================================
 */

/**
 * Recursively freezes an object graph so runtime code cannot mutate configuration.
 * @template T
 * @param {T} target
 * @returns {T}
 */
function deepFreeze(target) {
    if (target === null || typeof target !== 'object') {
        return target;
    }

    const propNames = Object.getOwnPropertyNames(target);
    for (const name of propNames) {
        const value = target[name];
        if (value && typeof value === 'object') {
            deepFreeze(value);
        }
    }

    return Object.freeze(target);
}

/**
 * Semantic Lead Status definitions (labels, Tailwind badge classes, and dot accents).
 */
export const LEAD_STATUSES = deepFreeze({
    new: {
        key: 'new',
        label: 'جديد',
        badgeClass: 'bg-rose-50 text-rose-700 border border-rose-200',
        dotClass: 'bg-rose-500',
        pulse: true
    },
    contacted: {
        key: 'contacted',
        label: 'تم التواصل',
        badgeClass: 'bg-sky-50 text-sky-700 border border-sky-200',
        dotClass: 'bg-sky-500',
        pulse: false
    },
    interested: {
        key: 'interested',
        label: 'مهتم',
        badgeClass: 'bg-amber-50 text-amber-700 border border-amber-200',
        dotClass: 'bg-amber-500',
        pulse: false
    },
    won: {
        key: 'won',
        label: 'تم البيع',
        badgeClass: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
        dotClass: 'bg-emerald-500',
        pulse: false
    },
    no_answer: {
        key: 'no_answer',
        label: 'لم يرد',
        badgeClass: 'bg-slate-100 text-slate-600 border border-slate-200',
        dotClass: 'bg-slate-400',
        pulse: false
    }
});

/**
 * Global application configuration object.
 */
export const APP_CONFIG = deepFreeze({
    supabase: {
        // Replace with your Supabase Project URL (Settings -> API -> Project URL)
        url: 'https://gdxphhshwicsfuuhqruz.supabase.co',
        // Replace with your public Supabase Anon Key (protected by PostgreSQL RLS)
        anonKey: 'sb_publishable_Ek4c65n5bgSMLhjFa36x7w_71HRp_df'
    },

    branding: {
        // White-label company / workspace brand name shown across login & navbar
        brandName: 'أسرع',
        dashboardSubtitle: 'لوحة إدارة العملاء والتحليلات',
        // Optional HTTPS URL or relative path (e.g., './assets/logo.png').
        // Leave empty ('') to render the default executive vector icon badge.
        logoUrl: '',
        // Optional browser tab icon URL
        faviconUrl: '',
        supportFooterText: 'نظام إدارة العملاء والتحليلات السحابي'
    },

    regional: {
        // Primary UI & date/time locale
        locale: 'ar-EG',
        // Ensures clean tabular Western digits (0-9) for KPIs, timestamps, and phone numbers
        numberLocale: 'en-US',
        // Default international dialing prefix (digits only, without '+')
        // Examples: '20' (Egypt), '966' (Saudi Arabia), '971' (UAE), '965' (Kuwait)
        defaultCountryCode: '20'
    },

    whatsapp: {
        // Supported placeholders: {name}, {brandName}
        messageTemplate:
            'مرحباً {name}، شكراً لتواصلك مع {brandName}. وصلنا طلبك ويسعدنا مساعدتك في أقرب وقت.'
    },

    dashboard: {
        pageSize: 25,
        // Allowed values: 'today' | '7d' | '30d' | 'all'
        defaultDateRange: '7d',
        soundEnabledByDefault: true,
        toastDurationMs: 5000,
        csvFilenamePrefix: 'leads-export'
    },

    leadStatuses: LEAD_STATUSES
});

export default APP_CONFIG;
