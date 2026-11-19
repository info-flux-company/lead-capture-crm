/**
 * ============================================================================
 * Security, Sanitization, Formatting & Safe Export Utilities
 * ============================================================================
 * Centralized single-responsibility helper class enforcing:
 * - Strict XSS escaping (escapeHTML) and safe URL validation
 * - Arabic/Latin phone sanitization and international WhatsApp formatting
 * - Arabic relative & exact timestamp formatting (tabular Western digits)
 * - Owner-only CSV export with UTF-8 BOM and CWE-1236 formula neutralization
 * ============================================================================
 */

import { APP_CONFIG, LEAD_STATUSES } from '../config.js';

const HTML_ESCAPE_MAP = Object.freeze({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;',
    '/': '&#x2F;'
});

const HTML_ESCAPE_REGEX = /[&<>"'`/]/g;
const CSV_FORMULA_PREFIX_REGEX = /^[\t\r ]*[=+\-@]/;
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/;

/**
 * Pure static utility class for frontend security, formatting, and CSV export.
 */
export class SecurityUtils {
    /**
     * Escapes special HTML characters to prevent DOM XSS injection.
     * @param {unknown} value
     * @returns {string}
     */
    static escapeHTML(value) {
        if (value === null || value === undefined) {
            return '';
        }
        return String(value).replace(HTML_ESCAPE_REGEX, (ch) => HTML_ESCAPE_MAP[ch]);
    }

    /**
     * Converts Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits to ASCII 0-9.
     * @param {unknown} value
     * @returns {string}
     */
    static normalizeArabicDigits(value) {
        if (value === null || value === undefined) {
            return '';
        }
        return String(value)
            .replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660))
            .replace(/[\u06F0-\u06F9]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0));
    }

    /**
     * Sanitizes a raw phone number, preserving an optional leading '+' and up to 15 digits.
     * @param {unknown} rawPhone
     * @returns {string}
     */
    static sanitizePhone(rawPhone) {
        if (rawPhone === null || rawPhone === undefined) {
            return '';
        }
        const normalized = this.normalizeArabicDigits(rawPhone).trim();
        if (!normalized) {
            return '';
        }

        const hasLeadingPlus = normalized.startsWith('+');
        const digits = normalized.replace(/\D/g, '').slice(0, 15);
        if (!digits) {
            return '';
        }

        return hasLeadingPlus ? `+${digits}` : digits;
    }

    /**
     * Formats a phone number into clean digits suitable for `https://wa.me/{digits}`
     * without duplicating the default country code.
     * @param {unknown} rawPhone
     * @param {string} [defaultCountryCode]
     * @returns {string}
     */
    static formatWhatsAppPhone(
        rawPhone,
        defaultCountryCode = APP_CONFIG.regional.defaultCountryCode
    ) {
        const sanitized = this.sanitizePhone(rawPhone);
        if (!sanitized) {
            return '';
        }

        const cleanCountry = String(defaultCountryCode || '').replace(/\D/g, '');
        let digits = '';

        if (sanitized.startsWith('+')) {
            digits = sanitized.slice(1);
        } else if (sanitized.startsWith('00')) {
            digits = sanitized.slice(2);
        } else if (
            cleanCountry &&
            sanitized.startsWith(cleanCountry) &&
            sanitized.length >= cleanCountry.length + 7
        ) {
            digits = sanitized;
        } else {
            const withoutLeadingZeros = sanitized.replace(/^0+/, '');
            digits = cleanCountry ? `${cleanCountry}${withoutLeadingZeros}` : withoutLeadingZeros;
        }

        if (digits.length < 7) {
            return '';
        }

        return digits.slice(0, 15);
    }

    /**
     * Builds a safe WhatsApp click-to-chat URL with pre-filled Arabic greeting.
     * @param {unknown} phone
     * @param {string} [leadName]
     * @param {{ countryCode?: string, template?: string, brandName?: string }} [options]
     * @returns {string | null}
     */
    static buildWhatsAppUrl(phone, leadName = '', options = {}) {
        const countryCode = options.countryCode ?? APP_CONFIG.regional.defaultCountryCode;
        const waPhone = this.formatWhatsAppPhone(phone, countryCode);
        if (!waPhone) {
            return null;
        }

        const template =
            typeof options.template === 'string' && options.template.trim()
                ? options.template
                : APP_CONFIG.whatsapp.messageTemplate;
        const brandName =
            typeof options.brandName === 'string' && options.brandName.trim()
                ? options.brandName
                : APP_CONFIG.branding.brandName;
        const displayName =
            typeof leadName === 'string' && leadName.trim() ? leadName.trim() : 'عميلنا العزيز';

        const message = template
            .replace(/\{name\}/g, displayName)
            .replace(/\{brandName\}/g, brandName);

        return `https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`;
    }

    /**
     * Builds a safe `tel:` URI for one-tap mobile dialing.
     * @param {unknown} phone
     * @returns {string | null}
     */
    static buildTelUrl(phone) {
        const clean = this.sanitizePhone(phone);
        const digitsOnly = clean.replace(/\D/g, '');
        if (digitsOnly.length < 5) {
            return null;
        }
        return `tel:${clean}`;
    }

    /**
     * Validates external or relative asset URLs (blocks javascript:, data:, vbscript:, //).
     * @param {unknown} rawUrl
     * @returns {string}
     */
    static sanitizeSafeUrl(rawUrl) {
        if (typeof rawUrl !== 'string') {
            return '';
        }

        const trimmed = rawUrl.trim();
        if (!trimmed || CONTROL_CHARS_REGEX.test(trimmed) || trimmed.startsWith('//')) {
            return '';
        }

        if (trimmed.startsWith('./') || trimmed.startsWith('/')) {
            return trimmed;
        }

        try {
            const parsed = new URL(trimmed);
            if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
                return parsed.href;
            }
            return '';
        } catch {
            return '';
        }
    }

    /**
     * Formats an ISO timestamp into grammatically natural Arabic relative time.
     * @param {string | number | Date} isoDateString
     * @param {Date | number} [now]
     * @returns {string}
     */
    static formatRelativeTimeArabic(isoDateString, now = new Date()) {
        const target = isoDateString instanceof Date ? isoDateString : new Date(isoDateString);
        const ref = now instanceof Date ? now : new Date(now);

        if (Number.isNaN(target.getTime()) || Number.isNaN(ref.getTime())) {
            return 'غير معروف';
        }

        const diffSeconds = Math.floor((ref.getTime() - target.getTime()) / 1000);
        if (diffSeconds < 45) {
            return 'الآن';
        }

        const minutes = Math.floor(diffSeconds / 60);
        if (minutes < 60) {
            if (minutes === 1) return 'منذ دقيقة';
            if (minutes === 2) return 'منذ دقيقتين';
            if (minutes <= 10) return `منذ ${minutes} دقائق`;
            return `منذ ${minutes} دقيقة`;
        }

        const hours = Math.floor(minutes / 60);
        if (hours < 24) {
            if (hours === 1) return 'منذ ساعة';
            if (hours === 2) return 'منذ ساعتين';
            if (hours <= 10) return `منذ ${hours} ساعات`;
            return `منذ ${hours} ساعة`;
        }

        const days = Math.floor(hours / 24);
        if (days < 30) {
            if (days === 1) return 'منذ يوم';
            if (days === 2) return 'منذ يومين';
            if (days <= 10) return `منذ ${days} أيام`;
            return `منذ ${days} يوماً`;
        }

        const months = Math.floor(days / 30);
        if (months < 12) {
            if (months === 1) return 'منذ شهر';
            if (months === 2) return 'منذ شهرين';
            if (months <= 10) return `منذ ${months} أشهر`;
            return `منذ ${months} شهراً`;
        }

        const years = Math.floor(days / 365);
        if (years <= 1) return 'منذ سنة';
        if (years === 2) return 'منذ سنتين';
        if (years <= 10) return `منذ ${years} سنوات`;
        return `منذ ${years} سنة`;
    }

    /**
     * Formats an ISO timestamp into a clean localized Arabic date & time using Western digits.
     * @param {string | number | Date} isoDateString
     * @param {string} [locale]
     * @returns {string}
     */
    static formatExactTimestampArabic(isoDateString, locale = APP_CONFIG.regional.locale) {
        const target = isoDateString instanceof Date ? isoDateString : new Date(isoDateString);
        if (Number.isNaN(target.getTime())) {
            return 'غير معروف';
        }

        try {
            return new Intl.DateTimeFormat(locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
                numberingSystem: 'latn'
            }).format(target);
        } catch {
            return target.toISOString();
        }
    }

    /**
     * Escapes a single CSV cell and neutralizes formula injection (CWE-1236).
     * @param {unknown} value
     * @returns {string}
     */
    static sanitizeCSVCell(value) {
        if (value === null || value === undefined) {
            return '""';
        }

        let str = String(value);
        if (CSV_FORMULA_PREFIX_REGEX.test(str)) {
            str = `'${str}`;
        }

        return `"${str.replace(/"/g, '""')}"`;
    }

    /**
     * Generates UTF-8 BOM CSV string for filtered leads. Strictly restricted to `owner`.
     * @param {Array<Record<string, any>>} leads
     * @param {string} role
     * @returns {string}
     */
    static generateSafeCSVContent(leads, role) {
        if (role !== 'owner') {
            throw new Error('غير مصرح: تصدير ملفات CSV متاح لمدير النظام (Owner) فقط.');
        }

        const safeLeads = Array.isArray(leads) ? leads : [];
        const headers = [
            'الاسم',
            'رقم الهاتف',
            'المحافظة',
            'الدولة',
            'مصدر الزيارة',
            'الصفحة',
            'الحالة',
            'الملاحظات',
            'تاريخ الطلب'
        ];

        const lines = [headers.map((header) => this.sanitizeCSVCell(header)).join(',')];

        for (const lead of safeLeads) {
            const statusKey = lead?.status || '';
            const statusLabel = LEAD_STATUSES[statusKey]?.label || statusKey;
            const pageLabel = lead?.pages?.title || lead?.pages?.slug || '';
            const createdFormatted = lead?.created_at
                ? this.formatExactTimestampArabic(lead.created_at)
                : '';

            const row = [
                lead?.name || '',
                lead?.phone || '',
                lead?.city || '',
                lead?.country || '',
                lead?.utm_source || '',
                pageLabel,
                statusLabel,
                lead?.notes || '',
                createdFormatted
            ];

            lines.push(row.map((cell) => this.sanitizeCSVCell(cell)).join(','));
        }

        return `\uFEFF${lines.join('\r\n')}`;
    }

    /**
     * Triggers an Excel-compatible UTF-8 BOM CSV download in the browser.
     * Double-verifies `role === 'owner'`.
     * @param {Array<Record<string, any>>} leads
     * @param {string} role
     * @param {string} [filenamePrefix]
     * @returns {{ exportedCount: number, filename: string }}
     */
    static exportSafeCSV(
        leads,
        role,
        filenamePrefix = APP_CONFIG.dashboard.csvFilenamePrefix
    ) {
        const csvContent = this.generateSafeCSVContent(leads, role);
        const safePrefix =
            String(filenamePrefix || 'leads-export').replace(/[^a-zA-Z0-9_-]/g, '') ||
            'leads-export';
        const dateStamp = new Date().toISOString().slice(0, 10);
        const filename = `${safePrefix}-${dateStamp}.csv`;

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const objectUrl = URL.createObjectURL(blob);

        try {
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = filename;
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
        } finally {
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        }

        return {
            exportedCount: Array.isArray(leads) ? leads.length : 0,
            filename
        };
    }
}

export default SecurityUtils;
