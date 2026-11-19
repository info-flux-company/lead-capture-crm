/**
 * ============================================================================
 * Executive RTL Toast Notification Manager
 * ============================================================================
 * Renders stacked, XSS-safe notifications inside the native Top-Layer
 * `popover="manual"` container with graceful fallback for older browsers.
 * ============================================================================
 */

import APP_CONFIG from '../config.js';

const MAX_STACKED_TOASTS = 4;

const TOAST_VARIANTS = Object.freeze({
    success: {
        icon: 'check-circle-2',
        wrapperClass: 'border-emerald-200 bg-white text-slate-900',
        iconWrapClass: 'bg-emerald-50 text-emerald-600'
    },
    error: {
        icon: 'alert-circle',
        wrapperClass: 'border-rose-200 bg-white text-slate-900',
        iconWrapClass: 'bg-rose-50 text-rose-600'
    },
    info: {
        icon: 'info',
        wrapperClass: 'border-sky-200 bg-white text-slate-900',
        iconWrapClass: 'bg-sky-50 text-sky-600'
    },
    lead: {
        icon: 'bell-ring',
        wrapperClass: 'border-blue-300 bg-white text-slate-900 ring-2 ring-blue-500/15',
        iconWrapClass: 'bg-gradient-to-l from-blue-600 to-indigo-600 text-white'
    }
});

/**
 * Manages stacked floating toast notifications using the Top-Layer Popover API.
 */
export class ToastManager {
    /** @type {HTMLElement | null} */
    #container;

    /** @type {Map<HTMLElement, { timerId: number | null, remainingMs: number, startedAt: number, duration: number }>} */
    #activeToasts = new Map();

    /**
     * @param {string} [containerId]
     */
    constructor(containerId = 'toast-container') {
        this.#container =
            typeof document !== 'undefined' ? document.getElementById(containerId) : null;
    }

    /**
     * Displays a toast notification safely using textContent.
     * @param {{ title: string, message?: string, type?: 'success' | 'error' | 'info' | 'lead', duration?: number }} options
     * @returns {HTMLElement | null}
     */
    show({
        title,
        message = '',
        type = 'info',
        duration = APP_CONFIG.dashboard.toastDurationMs
    } = {}) {
        const container = this.#getContainer();
        if (!container) {
            return null;
        }

        // Evict oldest toast when stack reaches capacity
        while (this.#activeToasts.size >= MAX_STACKED_TOASTS) {
            const oldest = this.#activeToasts.keys().next().value;
            if (!oldest) {
                break;
            }
            this.#dismiss(oldest, true);
        }

        const variant = TOAST_VARIANTS[type] || TOAST_VARIANTS.info;
        const toastEl = this.#buildToastElement({
            title: String(title || ''),
            message: String(message || ''),
            variant
        });

        container.prepend(toastEl);
        this.#showContainer(container);
        this.#hydrateIcons();

        const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
        const meta = {
            timerId: null,
            remainingMs: safeDuration,
            startedAt: Date.now(),
            duration: safeDuration
        };
        this.#activeToasts.set(toastEl, meta);

        if (safeDuration > 0) {
            this.#startTimer(toastEl, meta);
            toastEl.addEventListener('mouseenter', () => this.#pauseTimer(toastEl));
            toastEl.addEventListener('mouseleave', () => this.#resumeTimer(toastEl));
        }

        return toastEl;
    }

    /**
     * Convenience wrapper for success notifications.
     * @param {string} title
     * @param {string} [message]
     * @param {number} [duration]
     * @returns {HTMLElement | null}
     */
    success(title, message = '', duration = APP_CONFIG.dashboard.toastDurationMs) {
        return this.show({ title, message, type: 'success', duration });
    }

    /**
     * Convenience wrapper for error notifications.
     * @param {string} title
     * @param {string} [message]
     * @param {number} [duration]
     * @returns {HTMLElement | null}
     */
    error(title, message = '', duration = APP_CONFIG.dashboard.toastDurationMs) {
        return this.show({ title, message, type: 'error', duration });
    }

    /**
     * Convenience wrapper for informational notifications.
     * @param {string} title
     * @param {string} [message]
     * @param {number} [duration]
     * @returns {HTMLElement | null}
     */
    info(title, message = '', duration = APP_CONFIG.dashboard.toastDurationMs) {
        return this.show({ title, message, type: 'info', duration });
    }

    /**
     * Convenience wrapper for live Realtime incoming lead notifications.
     * @param {string} title
     * @param {string} [message]
     * @param {number} [duration]
     * @returns {HTMLElement | null}
     */
    lead(title, message = '', duration = APP_CONFIG.dashboard.toastDurationMs + 1500) {
        return this.show({ title, message, type: 'lead', duration });
    }

    /**
     * Dismisses all active toasts immediately.
     */
    clearAll() {
        for (const toastEl of Array.from(this.#activeToasts.keys())) {
            this.#dismiss(toastEl, true);
        }
    }

    /**
     * Resolves the toast container lazily in case DOM was not ready at construction.
     * @returns {HTMLElement | null}
     */
    #getContainer() {
        if (!this.#container && typeof document !== 'undefined') {
            this.#container = document.getElementById('toast-container');
        }
        return this.#container;
    }

    /**
     * Builds the toast DOM structure strictly via createElement & textContent.
     * @param {{ title: string, message: string, variant: { icon: string, wrapperClass: string, iconWrapClass: string } }} params
     * @returns {HTMLElement}
     */
    #buildToastElement({ title, message, variant }) {
        const toast = document.createElement('div');
        toast.setAttribute('role', 'status');
        toast.className = `crm-toast-item flex items-start gap-3 rounded-2xl border p-3.5 shadow-lg ${variant.wrapperClass}`;

        const iconWrap = document.createElement('div');
        iconWrap.className = `flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${variant.iconWrapClass}`;
        const iconEl = document.createElement('i');
        iconEl.setAttribute('data-lucide', variant.icon);
        iconEl.setAttribute('stroke-width', '1.75');
        iconEl.className = 'h-4 w-4';
        iconWrap.appendChild(iconEl);

        const body = document.createElement('div');
        body.className = 'min-w-0 flex-1 pt-0.5';

        const titleEl = document.createElement('p');
        titleEl.className = 'text-xs font-bold text-slate-900';
        titleEl.textContent = title;
        body.appendChild(titleEl);

        if (message) {
            const msgEl = document.createElement('p');
            msgEl.className = 'mt-0.5 text-xs leading-relaxed text-slate-600 break-words';
            msgEl.textContent = message;
            body.appendChild(msgEl);
        }

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'إغلاق الإشعار');
        closeBtn.className =
            'shrink-0 rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none';
        const closeIcon = document.createElement('i');
        closeIcon.setAttribute('data-lucide', 'x');
        closeIcon.setAttribute('stroke-width', '1.75');
        closeIcon.className = 'h-3.5 w-3.5';
        closeBtn.appendChild(closeIcon);

        closeBtn.addEventListener('click', () => this.#dismiss(toast));

        toast.appendChild(iconWrap);
        toast.appendChild(body);
        toast.appendChild(closeBtn);

        return toast;
    }

    /**
     * Promotes the manual popover container into the browser's Top Layer.
     * @param {HTMLElement} container
     */
    #showContainer(container) {
        try {
            if (typeof container.showPopover === 'function') {
                if (!container.matches(':popover-open')) {
                    container.showPopover();
                }
            } else {
                container.classList.add('toast-fallback-open');
            }
        } catch {
            container.classList.add('toast-fallback-open');
        }
    }

    /**
     * Hides the popover container once no active toasts remain.
     * @param {HTMLElement} container
     */
    #hideContainerIfEmpty(container) {
        if (this.#activeToasts.size > 0 || container.childElementCount > 0) {
            return;
        }
        try {
            if (typeof container.hidePopover === 'function') {
                if (container.matches(':popover-open')) {
                    container.hidePopover();
                }
            }
        } catch {
            // Ignore popover hide errors
        }
        container.classList.remove('toast-fallback-open');
    }

    /**
     * Starts an auto-dismiss timer for a toast element.
     * @param {HTMLElement} toastEl
     * @param {{ timerId: number | null, remainingMs: number, startedAt: number, duration: number }} meta
     */
    #startTimer(toastEl, meta) {
        if (meta.timerId !== null) {
            clearTimeout(meta.timerId);
        }
        meta.startedAt = Date.now();
        meta.timerId = window.setTimeout(() => {
            this.#dismiss(toastEl);
        }, meta.remainingMs);
    }

    /**
     * Pauses auto-dismiss countdown when user hovers over the toast.
     * @param {HTMLElement} toastEl
     */
    #pauseTimer(toastEl) {
        const meta = this.#activeToasts.get(toastEl);
        if (!meta || meta.timerId === null) {
            return;
        }
        clearTimeout(meta.timerId);
        meta.timerId = null;
        const elapsed = Date.now() - meta.startedAt;
        meta.remainingMs = Math.max(400, meta.remainingMs - elapsed);
    }

    /**
     * Resumes auto-dismiss countdown when pointer leaves the toast.
     * @param {HTMLElement} toastEl
     */
    #resumeTimer(toastEl) {
        const meta = this.#activeToasts.get(toastEl);
        if (!meta || meta.duration <= 0 || meta.timerId !== null) {
            return;
        }
        this.#startTimer(toastEl, meta);
    }

    /**
     * Dismisses a single toast with exit transition cleanup.
     * @param {HTMLElement} toastEl
     * @param {boolean} [immediate]
     */
    #dismiss(toastEl, immediate = false) {
        const meta = this.#activeToasts.get(toastEl);
        if (meta && meta.timerId !== null) {
            clearTimeout(meta.timerId);
        }
        this.#activeToasts.delete(toastEl);

        const removeNode = () => {
            if (toastEl.parentNode) {
                toastEl.parentNode.removeChild(toastEl);
            }
            const container = this.#getContainer();
            if (container) {
                this.#hideContainerIfEmpty(container);
            }
        };

        if (immediate) {
            removeNode();
            return;
        }

        toastEl.classList.add('toast-exit');
        window.setTimeout(removeNode, 230);
    }

    /**
     * Hydrates newly created Lucide icon placeholders.
     */
    #hydrateIcons() {
        try {
            if (typeof window !== 'undefined' && window.lucide?.createIcons) {
                window.lucide.createIcons({ attrs: { 'stroke-width': 1.75 } });
            }
        } catch {
            // Ignore icon hydration failures
        }
    }
}

export default ToastManager;
