/**
 * ============================================================================
 * Main Application Controller (Orchestrator)
 * ============================================================================
 * Coordinates White-Label branding, Authentication, Data fetching, Filters,
 * Owner-only controls, Realtime Live updates, Charts, CRM Table, and Toasts.
 * ============================================================================
 */

import APP_CONFIG from './config.js';
import SecurityUtils from './utils/SecurityUtils.js';
import AuthService from './services/AuthService.js';
import DataService from './services/DataService.js';
import RealtimeService from './services/RealtimeService.js';
import ToastManager from './ui/ToastManager.js';
import ChartManager from './ui/ChartManager.js';
import TableManager from './ui/TableManager.js';

const RELATIVE_TIME_REFRESH_MS = 60000;
const SEARCH_DEBOUNCE_MS = 300;
const MAX_SEEN_REALTIME_IDS = 500;
const MAX_ANALYTICS_ROWS = 5000;

/**
 * Orchestrates the entire White-Label B2B Lead Capture & Analytics Dashboard.
 */
export class AppController {
    /** @type {AuthService} */
    #authService;

    /** @type {DataService} */
    #dataService;

    /** @type {RealtimeService} */
    #realtimeService;

    /** @type {ToastManager} */
    #toastManager;

    /** @type {ChartManager} */
    #chartManager;

    /** @type {TableManager} */
    #tableManager;

    /** @type {{ user: any, session: any, workspaceId: string, workspaceName: string, role: 'owner' | 'sales' } | null} */
    #sessionContext = null;

    /** @type {{ dateRange: string, pageId: string, status: string, search: string, page: number }} */
    #filters = {
        dateRange: APP_CONFIG.dashboard.defaultDateRange,
        pageId: 'all',
        status: 'all',
        search: '',
        page: 1
    };

    /** @type {{ totalViews: number, totalLeads: number, conversionRate: number, newLeadsCount: number }} */
    #metrics = {
        totalViews: 0,
        totalLeads: 0,
        conversionRate: 0,
        newLeadsCount: 0
    };

    /** @type {Array<Record<string, any>>} */
    #analyticsRows = [];

    /** @type {Map<string, { id: string, slug: string, title: string, is_published: boolean }>} */
    #pagesMap = new Map();

    /** @type {Set<string>} */
    #seenRealtimeIds = new Set();

    /** @type {number} */
    #loadSequence = 0;

    /** @type {number | null} */
    #searchDebounceTimer = null;

    /** @type {number | null} */
    #relativeTimeTimer = null;

    /** @type {(() => void) | null} */
    #authUnsubscribe = null;

    /** @type {boolean} */
    #isHandlingAuthTransition = false;

    constructor({
        authService = new AuthService(),
        dataService = new DataService(),
        realtimeService = new RealtimeService(),
        toastManager = new ToastManager(),
        chartManager = new ChartManager()
    } = {}) {
        this.#authService = authService;
        this.#dataService = dataService;
        this.#realtimeService = realtimeService;
        this.#toastManager = toastManager;
        this.#chartManager = chartManager;

        this.#tableManager = new TableManager({
            onStatusChange: (lead, nextStatus, revert) =>
                this.#handleStatusChange(lead, nextStatus, revert),
            onSaveNotes: (lead, notes) => this.#handleSaveNotes(lead, notes),
            onDeleteLead: (lead) => this.#handleDeleteLead(lead),
            onPageChange: (nextPage) => {
                this.#filters.page = nextPage;
                this.#loadDashboardData({ reloadAnalytics: false, reloadMetrics: false });
            },
            onNotify: (toastOpts) => this.#toastManager.show(toastOpts)
        });
    }

    /**
     * Initializes branding, DOM listeners, configuration checks, and auth session.
     * @returns {Promise<void>}
     */
    async init() {
        this.#applyWhiteLabelBranding();
        this.#refreshIcons();
        this.#bindGlobalAudioUnlock();
        this.#bindLoginEvents();
        this.#bindDashboardEvents();

        if (!this.#authService.isBackendConfigured()) {
            this.#showConfigurationWarning(this.#authService.getConfigurationError());
            this.#showLoginView();
            return;
        }

        try {
            const sessionContext = await this.#authService.getSessionContext();
            if (sessionContext) {
                await this.#enterDashboard(sessionContext);
            } else {
                this.#showLoginView();
            }
        } catch (err) {
            this.#showLoginError(
                err instanceof Error ? err.message : 'تعذر التحقق من الجلسة الحالية.'
            );
            this.#showLoginView();
        }

        this.#authUnsubscribe = this.#authService.onAuthStateChange(
            async ({ authenticated, context }) => {
                if (this.#isHandlingAuthTransition) {
                    return;
                }
                if (!authenticated || !context) {
                    if (this.#sessionContext) {
                        await this.#exitDashboard();
                    }
                    return;
                }

                const isSameSession =
                    this.#sessionContext &&
                    this.#sessionContext.user?.id === context.user?.id &&
                    this.#sessionContext.workspaceId === context.workspaceId;

                if (!isSameSession) {
                    await this.#enterDashboard(context);
                }
            }
        );
    }

    /**
     * Applies White-Label brand name, subtitle, footer, favicon, and optional logo URL.
     */
    #applyWhiteLabelBranding() {
        if (typeof document === 'undefined') {
            return;
        }

        const { brandName, dashboardSubtitle, logoUrl, faviconUrl, supportFooterText } =
            APP_CONFIG.branding;

        const titleEl = document.getElementById('app-title');
        if (titleEl) {
            titleEl.textContent = `${brandName} | ${dashboardSubtitle}`;
        } else {
            document.title = `${brandName} | ${dashboardSubtitle}`;
        }

        const safeFavicon = SecurityUtils.sanitizeSafeUrl(faviconUrl);
        if (safeFavicon) {
            const faviconEl = document.getElementById('app-favicon');
            if (faviconEl) {
                faviconEl.setAttribute('href', safeFavicon);
            }
        }

        const loginBrandName = document.getElementById('login-brand-name');
        const loginSubtitle = document.getElementById('login-brand-subtitle');
        const loginFooter = document.getElementById('login-footer-text');
        const navWorkspace = document.getElementById('nav-workspace-name');

        if (loginBrandName) loginBrandName.textContent = brandName;
        if (loginSubtitle) loginSubtitle.textContent = dashboardSubtitle;
        if (loginFooter) loginFooter.textContent = supportFooterText;
        if (navWorkspace) navWorkspace.textContent = brandName;

        const safeLogoUrl = SecurityUtils.sanitizeSafeUrl(logoUrl);
        if (safeLogoUrl) {
            this.#mountBrandLogo('login-brand-logo', safeLogoUrl, brandName, 'h-7 w-7');
            this.#mountBrandLogo('nav-brand-logo', safeLogoUrl, brandName, 'h-5 w-5');
        }
    }

    /**
     * Safely mounts a custom brand logo <img> with automatic vector icon fallback on load error.
     * @param {string} containerId
     * @param {string} safeUrl
     * @param {string} altText
     * @param {string} fallbackIconClass
     */
    #mountBrandLogo(containerId, safeUrl, altText, fallbackIconClass) {
        const container = document.getElementById(containerId);
        if (!container) {
            return;
        }

        const img = document.createElement('img');
        img.src = safeUrl;
        img.alt = altText;
        img.className = 'h-full w-full object-cover';
        img.addEventListener('error', () => {
            const fallbackIcon = document.createElement('i');
            fallbackIcon.setAttribute('data-lucide', 'bar-chart-3');
            fallbackIcon.setAttribute('stroke-width', '1.75');
            fallbackIcon.className = fallbackIconClass;
            container.replaceChildren(fallbackIcon);
            this.#refreshIcons();
        });

        container.replaceChildren(img);
    }

    /**
     * Unlocks Web Audio API on the user's first interaction so Realtime chimes play cleanly.
     */
    #bindGlobalAudioUnlock() {
        if (typeof document === 'undefined') {
            return;
        }
        const unlockOnce = () => {
            this.#realtimeService.unlockAudio();
            document.removeEventListener('pointerdown', unlockOnce);
            document.removeEventListener('keydown', unlockOnce);
        };
        document.addEventListener('pointerdown', unlockOnce, { passive: true });
        document.addEventListener('keydown', unlockOnce, { passive: true });
    }

    /**
     * Wires login form submission and show/hide password toggle.
     */
    #bindLoginEvents() {
        if (typeof document === 'undefined') {
            return;
        }

        const form = document.getElementById('login-form');
        const emailInput = document.getElementById('email');
        const passwordInput = document.getElementById('current-password');
        const togglePwdBtn = document.getElementById('toggle-password-btn');
        const togglePwdIcon = document.getElementById('toggle-password-icon');

        togglePwdBtn?.addEventListener('click', () => {
            if (!passwordInput) {
                return;
            }
            const nextVisible = passwordInput.type === 'password';
            passwordInput.type = nextVisible ? 'text' : 'password';
            togglePwdBtn.setAttribute('aria-pressed', nextVisible ? 'true' : 'false');
            togglePwdBtn.setAttribute(
                'aria-label',
                nextVisible ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'
            );
            if (togglePwdIcon) {
                togglePwdIcon.setAttribute('data-lucide', nextVisible ? 'eye-off' : 'eye');
                this.#refreshIcons();
            }
            // Also restore <i> if Lucide converted it to <svg>
            const svg = togglePwdBtn.querySelector('svg');
            if (svg) {
                const icon = document.createElement('i');
                icon.id = 'toggle-password-icon';
                icon.setAttribute('data-lucide', nextVisible ? 'eye-off' : 'eye');
                icon.setAttribute('stroke-width', '1.75');
                icon.className = 'h-4 w-4';
                svg.replaceWith(icon);
                this.#refreshIcons();
            }
        });

        form?.addEventListener('submit', async (event) => {
            event.preventDefault();
            this.#hideLoginError();
            this.#realtimeService.unlockAudio();

            if (!this.#authService.isBackendConfigured()) {
                this.#showLoginError(
                    this.#authService.getConfigurationError() || 'إعدادات Supabase غير مكتملة.'
                );
                return;
            }

            const email = emailInput?.value.trim() || '';
            const password = passwordInput?.value || '';
            if (!email || !password) {
                this.#showLoginError('يرجى إدخال البريد الإلكتروني وكلمة المرور.');
                return;
            }

            this.#setLoginLoading(true);
            this.#isHandlingAuthTransition = true;
            try {
                const context = await this.#authService.signIn(email, password);
                if (passwordInput) {
                    passwordInput.value = '';
                }
                await this.#enterDashboard(context);
            } catch (err) {
                this.#showLoginError(
                    err instanceof Error ? err.message : 'تعذر تسجيل الدخول. يرجى المحاولة مجدداً.'
                );
            } finally {
                this.#isHandlingAuthTransition = false;
                this.#setLoginLoading(false);
            }
        });
    }

    /**
     * Wires dashboard filters, search debounce, refresh, sound toggle, and logout.
     */
    #bindDashboardEvents() {
        if (typeof document === 'undefined') {
            return;
        }

        // Date Range pills
        const dateRangeContainer = document.getElementById('date-range-filters');
        dateRangeContainer?.addEventListener('click', (event) => {
            const btn = event.target instanceof Element ? event.target.closest('[data-range]') : null;
            if (!btn) {
                return;
            }
            const nextRange = btn.getAttribute('data-range');
            if (!nextRange || nextRange === this.#filters.dateRange) {
                return;
            }
            this.#filters.dateRange = nextRange;
            this.#filters.page = 1;
            this.#syncFilterControlsUI();
            this.#loadDashboardData({ reloadAnalytics: true, reloadMetrics: true });
        });

        // Page filter
        const pageSelect = document.getElementById('page-filter-select');
        pageSelect?.addEventListener('change', () => {
            this.#filters.pageId = pageSelect.value || 'all';
            this.#filters.page = 1;
            this.#syncClearFiltersButton();
            this.#loadDashboardData({ reloadAnalytics: true, reloadMetrics: true });
        });

        // Status filter
        const statusSelect = document.getElementById('status-filter-select');
        statusSelect?.addEventListener('change', () => {
            this.#filters.status = statusSelect.value || 'all';
            this.#filters.page = 1;
            this.#syncClearFiltersButton();
            this.#loadDashboardData({ reloadAnalytics: false, reloadMetrics: false });
        });

        // Debounced live search
        const searchInput = document.getElementById('search-input');
        searchInput?.addEventListener('input', () => {
            if (this.#searchDebounceTimer !== null) {
                clearTimeout(this.#searchDebounceTimer);
            }
            this.#searchDebounceTimer = window.setTimeout(() => {
                this.#filters.search = searchInput.value.trim();
                this.#filters.page = 1;
                this.#syncClearFiltersButton();
                this.#loadDashboardData({ reloadAnalytics: false, reloadMetrics: false });
            }, SEARCH_DEBOUNCE_MS);
        });

        // Clear Filters button
        const clearFiltersBtn = document.getElementById('clear-filters-btn');
        clearFiltersBtn?.addEventListener('click', () => {
            this.#filters = {
                dateRange: APP_CONFIG.dashboard.defaultDateRange,
                pageId: 'all',
                status: 'all',
                search: '',
                page: 1
            };
            this.#syncFilterControlsUI();
            this.#loadDashboardData({ reloadAnalytics: true, reloadMetrics: true });
        });

        // Sound Mute/Unmute toggle
        const soundBtn = document.getElementById('sound-toggle-btn');
        soundBtn?.addEventListener('click', () => {
            this.#realtimeService.unlockAudio();
            const isMuted = this.#realtimeService.toggleMute();
            this.#syncSoundToggleUI();
            if (!isMuted) {
                this.#realtimeService.playNotificationChime(true);
                this.#toastManager.info('تم تفعيل الصوت', 'ستصلك نغمة تنبيه عند وصول طلب جديد.');
            } else {
                this.#toastManager.info('تم كتم الصوت', 'تم كتم صوت التنبيهات الفورية.');
            }
        });

        // Manual refresh
        const refreshBtn = document.getElementById('refresh-btn');
        refreshBtn?.addEventListener('click', () => {
            this.#loadDashboardData({ reloadAnalytics: true, reloadMetrics: true });
        });

        // Logout
        const logoutBtn = document.getElementById('logout-btn');
        logoutBtn?.addEventListener('click', async () => {
            this.#isHandlingAuthTransition = true;
            try {
                await this.#authService.signOut();
                await this.#exitDashboard();
            } finally {
                this.#isHandlingAuthTransition = false;
            }
        });
    }

    /**
     * Transitions the SPA into the authenticated workspace dashboard.
     * @param {{ user: any, session: any, workspaceId: string, workspaceName: string, role: 'owner' | 'sales' }} context
     */
    async #enterDashboard(context) {
        this.#sessionContext = context;
        if (typeof document !== 'undefined') {
            document.body.dataset.role = context.role;
        }

        const navWorkspace = document.getElementById('nav-workspace-name');
        const navEmail = document.getElementById('nav-user-email');
        const roleBadge = document.getElementById('nav-role-badge');

        if (navWorkspace) {
            navWorkspace.textContent = context.workspaceName || APP_CONFIG.branding.brandName;
        }
        if (navEmail) {
            navEmail.textContent = context.user?.email || '';
        }
        if (roleBadge) {
            if (context.role === 'owner') {
                roleBadge.textContent = 'المدير';
                roleBadge.className =
                    'inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700';
            } else {
                roleBadge.textContent = 'فريق المبيعات';
                roleBadge.className =
                    'inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700';
            }
        }

        this.#syncOwnerControls(context.role);
        this.#tableManager.setRole(context.role);
        this.#syncSoundToggleUI();

        this.#filters = {
            dateRange: APP_CONFIG.dashboard.defaultDateRange,
            pageId: 'all',
            status: 'all',
            search: '',
            page: 1
        };
        this.#syncFilterControlsUI();

        this.#showDashboardView();
        this.#refreshIcons();

        await this.#loadPages(context.workspaceId);
        await this.#loadDashboardData({ reloadAnalytics: true, reloadMetrics: true });

        if (this.#relativeTimeTimer !== null) {
            clearInterval(this.#relativeTimeTimer);
        }
        this.#relativeTimeTimer = window.setInterval(() => {
            this.#tableManager.updateRelativeTimestamps();
        }, RELATIVE_TIME_REFRESH_MS);

        try {
            await this.#realtimeService.subscribe(context.workspaceId, {
                onNewLead: (lead) => this.#handleRealtimeLead(lead),
                onStatusChange: (status) => this.#updateRealtimeBadge(status)
            });
        } catch {
            this.#updateRealtimeBadge('CHANNEL_ERROR');
        }
    }

    /**
     * Tears down dashboard state, Realtime channel, charts, and owner-only DOM elements on logout.
     */
    async #exitDashboard() {
        this.#loadSequence += 1;

        if (this.#relativeTimeTimer !== null) {
            clearInterval(this.#relativeTimeTimer);
            this.#relativeTimeTimer = null;
        }
        if (this.#searchDebounceTimer !== null) {
            clearTimeout(this.#searchDebounceTimer);
            this.#searchDebounceTimer = null;
        }

        await this.#realtimeService.unsubscribe();
        this.#chartManager.destroy();

        const ownerSlot = document.getElementById('owner-actions-slot');
        ownerSlot?.replaceChildren();

        const pageSelect = document.getElementById('page-filter-select');
        if (pageSelect) {
            const allOption = document.createElement('option');
            allOption.value = 'all';
            allOption.textContent = 'كل الصفحات';
            pageSelect.replaceChildren(allOption);
        }

        if (typeof document !== 'undefined') {
            delete document.body.dataset.role;
        }

        this.#sessionContext = null;
        this.#pagesMap.clear();
        this.#seenRealtimeIds.clear();
        this.#analyticsRows = [];
        this.#tableManager.setRole('sales');
        this.#tableManager.renderLeads([], { totalCount: 0, page: 1, totalPages: 1 });

        this.#showLoginView();
    }

    /**
     * Dynamically injects the Export CSV button ONLY when the authenticated role is 'owner'.
     * Completely omitted from DOM for 'sales' users.
     * @param {'owner' | 'sales'} role
     */
    #syncOwnerControls(role) {
        const slot = document.getElementById('owner-actions-slot');
        if (!slot) {
            return;
        }

        slot.replaceChildren();
        if (role !== 'owner') {
            return;
        }

        const exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.id = 'export-csv-btn';
        exportBtn.className =
            'inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-l from-blue-600 to-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition-all hover:from-blue-700 hover:to-indigo-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60';

        const icon = document.createElement('i');
        icon.setAttribute('data-lucide', 'download');
        icon.setAttribute('stroke-width', '1.75');
        icon.className = 'h-3.5 w-3.5';

        const label = document.createElement('span');
        label.textContent = 'تصدير CSV';

        exportBtn.appendChild(icon);
        exportBtn.appendChild(label);
        exportBtn.addEventListener('click', () => this.#handleExportCSV(exportBtn));

        slot.appendChild(exportBtn);
        this.#refreshIcons();
    }

    /**
     * Loads workspace landing pages into the page selector and lookup map.
     * @param {string} workspaceId
     */
    async #loadPages(workspaceId) {
        const pageSelect = document.getElementById('page-filter-select');
        try {
            const pages = await this.#dataService.fetchPages(workspaceId);
            this.#pagesMap.clear();

            if (!pageSelect) {
                return;
            }

            const fragment = document.createDocumentFragment();
            const defaultOpt = document.createElement('option');
            defaultOpt.value = 'all';
            defaultOpt.textContent = 'كل الصفحات';
            fragment.appendChild(defaultOpt);

            for (const page of pages) {
                if (!page?.id) {
                    continue;
                }
                this.#pagesMap.set(page.id, page);
                const opt = document.createElement('option');
                opt.value = page.id;
                opt.textContent = page.title || page.slug;
                fragment.appendChild(opt);
            }

            pageSelect.replaceChildren(fragment);
            pageSelect.value = this.#filters.pageId;
        } catch (err) {
            this.#toastManager.error(
                'تنبيه',
                err instanceof Error ? err.message : 'تعذر تحميل قائمة الصفحات.'
            );
        }
    }

    /**
     * Fetches KPIs, analytics charts, and paginated leads in parallel with stale-response guard.
     * @param {{ reloadAnalytics?: boolean, reloadMetrics?: boolean }} [options]
     */
    async #loadDashboardData({ reloadAnalytics = true, reloadMetrics = true } = {}) {
        if (!this.#sessionContext?.workspaceId) {
            return;
        }

        const workspaceId = this.#sessionContext.workspaceId;
        const seq = ++this.#loadSequence;

        if (reloadMetrics) {
            this.#setKpiLoading(true);
        }
        if (reloadAnalytics) {
            this.#chartManager.setLoading(true);
        }
        this.#tableManager.renderSkeleton(6);

        try {
            const tasks = [
                this.#dataService.fetchLeads(workspaceId, {
                    dateRange: this.#filters.dateRange,
                    pageId: this.#filters.pageId,
                    status: this.#filters.status,
                    search: this.#filters.search,
                    page: this.#filters.page,
                    pageSize: APP_CONFIG.dashboard.pageSize
                })
            ];

            if (reloadMetrics) {
                tasks.push(
                    this.#dataService.fetchDashboardMetrics(workspaceId, {
                        dateRange: this.#filters.dateRange,
                        pageId: this.#filters.pageId
                    })
                );
            } else {
                tasks.push(Promise.resolve(null));
            }

            if (reloadAnalytics) {
                tasks.push(
                    this.#dataService.fetchAnalyticsData(workspaceId, {
                        dateRange: this.#filters.dateRange,
                        pageId: this.#filters.pageId
                    })
                );
            } else {
                tasks.push(Promise.resolve(null));
            }

            const [leadsRes, metricsRes, analyticsRes] = await Promise.all(tasks);

            if (seq !== this.#loadSequence || !this.#sessionContext) {
                return;
            }

            if (metricsRes) {
                this.#metrics = metricsRes;
                this.#setKpiLoading(false);
                this.#renderKpiCards();
            }

            if (analyticsRes) {
                this.#analyticsRows = analyticsRes.rows || [];
                this.#chartManager.updateData(analyticsRes);
            }

            this.#tableManager.renderLeads(leadsRes.leads, leadsRes);
        } catch (err) {
            if (seq !== this.#loadSequence) {
                return;
            }
            this.#setKpiLoading(false);
            this.#chartManager.setLoading(false);
            this.#tableManager.renderLeads([], { totalCount: 0, page: 1, totalPages: 1 });
            this.#toastManager.error(
                'خطأ في تحميل البيانات',
                err instanceof Error ? err.message : 'تعذر تحديث بيانات لوحة التحكم.'
            );
        }
    }

    /**
     * Handles live incoming Realtime lead inserts with deduplication, KPI, Chart, and Table updates.
     * @param {Record<string, any>} rawLead
     */
    #handleRealtimeLead(rawLead) {
        if (!this.#sessionContext || !rawLead?.id) {
            return;
        }
        if (rawLead.workspace_id !== this.#sessionContext.workspaceId) {
            return;
        }
        if (this.#seenRealtimeIds.has(rawLead.id) || this.#tableManager.hasLead(rawLead.id)) {
            return;
        }

        if (this.#seenRealtimeIds.size >= MAX_SEEN_REALTIME_IDS) {
            const firstId = this.#seenRealtimeIds.values().next().value;
            if (firstId) {
                this.#seenRealtimeIds.delete(firstId);
            }
        }
        this.#seenRealtimeIds.add(rawLead.id);

        const lead = { ...rawLead };
        if (lead.page_id && this.#pagesMap.has(lead.page_id)) {
            lead.pages = this.#pagesMap.get(lead.page_id);
        }

        const matchesPageFilter =
            this.#filters.pageId === 'all' || lead.page_id === this.#filters.pageId;

        if (matchesPageFilter) {
            this.#metrics.totalLeads = Number(this.#metrics.totalLeads || 0) + 1;
            if (lead.status === 'new') {
                this.#metrics.newLeadsCount = Number(this.#metrics.newLeadsCount || 0) + 1;
            }
            this.#metrics.conversionRate =
                this.#metrics.totalViews > 0
                    ? Number(((this.#metrics.totalLeads / this.#metrics.totalViews) * 100).toFixed(2))
                    : 0;
            this.#renderKpiCards();

            this.#analyticsRows = [
                {
                    created_at: lead.created_at,
                    city: lead.city,
                    country: lead.country,
                    utm_source: lead.utm_source
                },
                ...this.#analyticsRows
            ].slice(0, MAX_ANALYTICS_ROWS);

            const aggregated = this.#dataService.aggregateAnalytics(this.#analyticsRows);
            this.#chartManager.updateData(aggregated);
        }

        if (this.#filters.page === 1 && this.#doesLeadMatchTableFilters(lead)) {
            this.#tableManager.prependRealtimeLead(lead, APP_CONFIG.dashboard.pageSize);
        }

        const cityLabel =
            lead.city && lead.city.toLowerCase() !== 'unknown' ? ` • ${lead.city}` : '';
        this.#toastManager.lead(
            'طلب جديد وارد الآن',
            `${lead.name || 'عميل جديد'} (${lead.phone || ''})${cityLabel}`
        );
    }

    /**
     * Checks whether a Realtime lead matches active table page/status/search filters.
     * @param {Record<string, any>} lead
     * @returns {boolean}
     */
    #doesLeadMatchTableFilters(lead) {
        if (this.#filters.pageId !== 'all' && lead.page_id !== this.#filters.pageId) {
            return false;
        }
        if (this.#filters.status !== 'all' && lead.status !== this.#filters.status) {
            return false;
        }
        const searchTerm = this.#filters.search.trim().toLowerCase();
        if (searchTerm) {
            const asciiSearch = SecurityUtils.normalizeArabicDigits(searchTerm);
            const nameMatch = String(lead.name || '').toLowerCase().includes(searchTerm);
            const phoneMatch = String(lead.phone || '').toLowerCase().includes(asciiSearch);
            if (!nameMatch && !phoneMatch) {
                return false;
            }
        }
        return true;
    }

    /**
     * Persists a status dropdown change with optimistic rollback on error.
     * @param {Record<string, any>} lead
     * @param {string} nextStatus
     * @param {() => void} revert
     */
    async #handleStatusChange(lead, nextStatus, revert) {
        if (!this.#sessionContext?.workspaceId) {
            revert();
            return;
        }

        try {
            await this.#dataService.updateLeadStatus(
                lead.id,
                this.#sessionContext.workspaceId,
                nextStatus
            );
            this.#toastManager.success('تم التحديث', 'تم تغيير حالة الطلب بنجاح.');
            this.#refreshMetricsQuietly();
        } catch (err) {
            revert();
            this.#toastManager.error(
                'تعذر التحديث',
                err instanceof Error ? err.message : 'فشل تحديث حالة الطلب.'
            );
        }
    }

    /**
     * Persists notes edited inside the Notes modal.
     * @param {Record<string, any>} lead
     * @param {string} notes
     */
    async #handleSaveNotes(lead, notes) {
        if (!this.#sessionContext?.workspaceId) {
            return;
        }

        try {
            await this.#dataService.updateLeadNotes(
                lead.id,
                this.#sessionContext.workspaceId,
                notes
            );
            this.#toastManager.success('تم الحفظ', 'تم تحديث ملاحظات العميل بنجاح.');
        } catch (err) {
            this.#toastManager.error(
                'تعذر الحفظ',
                err instanceof Error ? err.message : 'فشل حفظ الملاحظات.'
            );
            throw err;
        }
    }

    /**
     * Deletes a lead (owner-only double verification) and refreshes KPIs/charts quietly.
     * @param {Record<string, any>} lead
     */
    async #handleDeleteLead(lead) {
        if (!this.#sessionContext?.workspaceId || !this.#authService.isOwner()) {
            this.#toastManager.error('غير مصرح', 'حذف الطلبات متاح لمدير النظام فقط.');
            throw new Error('Forbidden');
        }

        try {
            await this.#dataService.deleteLead(
                lead.id,
                this.#sessionContext.workspaceId,
                this.#sessionContext.role
            );
            this.#toastManager.success('تم الحذف', 'تم حذف الطلب نهائياً.');
            this.#refreshMetricsQuietly();
            this.#refreshAnalyticsQuietly();
        } catch (err) {
            this.#toastManager.error(
                'تعذر الحذف',
                err instanceof Error ? err.message : 'فشل حذف الطلب.'
            );
            throw err;
        }
    }

    /**
     * Exports all filtered leads to UTF-8 BOM CSV with strict Owner double-verification.
     * @param {HTMLButtonElement} exportBtn
     */
    async #handleExportCSV(exportBtn) {
        if (!this.#authService.isOwner() || this.#sessionContext?.role !== 'owner') {
            this.#toastManager.error('غير مصرح', 'تصدير ملفات CSV متاح لمدير النظام (Owner) فقط.');
            return;
        }

        exportBtn.disabled = true;
        try {
            const leads = await this.#dataService.fetchAllFilteredLeadsForExport(
                this.#sessionContext.workspaceId,
                this.#sessionContext.role,
                this.#filters
            );

            if (leads.length === 0) {
                this.#toastManager.info('لا توجد بيانات', 'لا توجد طلبات مطابقة للتصدير حالياً.');
                return;
            }

            const result = SecurityUtils.exportSafeCSV(leads, this.#sessionContext.role);
            this.#toastManager.success(
                'تم التصدير بنجاح',
                `تم تصدير ${result.exportedCount} سجل إلى ${result.filename}`
            );
        } catch (err) {
            this.#toastManager.error(
                'تعذر التصدير',
                err instanceof Error ? err.message : 'حدث خطأ أثناء تصدير الملف.'
            );
        } finally {
            exportBtn.disabled = false;
        }
    }

    /**
     * Quietly refreshes KPI counters from Supabase without showing full skeletons.
     */
    async #refreshMetricsQuietly() {
        if (!this.#sessionContext?.workspaceId) {
            return;
        }
        try {
            this.#metrics = await this.#dataService.fetchDashboardMetrics(
                this.#sessionContext.workspaceId,
                {
                    dateRange: this.#filters.dateRange,
                    pageId: this.#filters.pageId
                }
            );
            this.#renderKpiCards();
        } catch {
            // Silent background refresh
        }
    }

    /**
     * Quietly refreshes Chart.js analytics from Supabase after deletions.
     */
    async #refreshAnalyticsQuietly() {
        if (!this.#sessionContext?.workspaceId) {
            return;
        }
        try {
            const analyticsRes = await this.#dataService.fetchAnalyticsData(
                this.#sessionContext.workspaceId,
                {
                    dateRange: this.#filters.dateRange,
                    pageId: this.#filters.pageId
                }
            );
            this.#analyticsRows = analyticsRes.rows || [];
            this.#chartManager.updateData(analyticsRes);
        } catch {
            // Silent background refresh
        }
    }

    /**
     * Renders the 4 KPI cards with tabular numerals and rose alert accent when newLeadsCount > 0.
     */
    #renderKpiCards() {
        if (typeof document === 'undefined') {
            return;
        }

        const viewsEl = document.getElementById('kpi-total-views');
        const leadsEl = document.getElementById('kpi-total-leads');
        const convEl = document.getElementById('kpi-conversion-rate');
        const newEl = document.getElementById('kpi-new-leads');
        const newCard = document.getElementById('kpi-new-card');
        const newIconWrap = document.getElementById('kpi-new-icon-wrap');
        const newCaption = document.getElementById('kpi-new-caption');

        const numLocale = APP_CONFIG.regional.numberLocale;
        if (viewsEl) {
            viewsEl.textContent = Number(this.#metrics.totalViews || 0).toLocaleString(numLocale);
        }
        if (leadsEl) {
            leadsEl.textContent = Number(this.#metrics.totalLeads || 0).toLocaleString(numLocale);
        }
        if (convEl) {
            convEl.textContent = `${Number(this.#metrics.conversionRate || 0).toLocaleString(
                numLocale,
                { maximumFractionDigits: 2 }
            )}%`;
        }

        const newCount = Number(this.#metrics.newLeadsCount || 0);
        if (newEl) {
            newEl.textContent = newCount.toLocaleString(numLocale);
        }

        if (newCard && newIconWrap && newCaption) {
            if (newCount > 0) {
                newCard.className =
                    'rounded-2xl border border-rose-200 bg-rose-50/40 p-5 shadow-sm transition-all duration-200 hover:shadow-md';
                newIconWrap.className =
                    'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-100 text-rose-600 transition-colors';
                newCaption.textContent = 'تنتظر المتابعة الفورية';
                newCaption.className = 'mt-3 text-xs font-medium text-rose-600';
            } else {
                newCard.className =
                    'rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm transition-all duration-200 hover:shadow-md';
                newIconWrap.className =
                    'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500 transition-colors';
                newCaption.textContent = 'تتطلب متابعة فريق المبيعات';
                newCaption.className = 'mt-3 text-xs text-slate-400';
            }
        }
    }

    /**
     * Toggles KPI card skeleton placeholders while loading.
     * @param {boolean} isLoading
     */
    #setKpiLoading(isLoading) {
        if (typeof document === 'undefined') {
            return;
        }
        const pairs = [
            ['kpi-views-skeleton', 'kpi-total-views'],
            ['kpi-leads-skeleton', 'kpi-total-leads'],
            ['kpi-conversion-skeleton', 'kpi-conversion-rate'],
            ['kpi-new-skeleton', 'kpi-new-leads']
        ];

        for (const [skeletonId, valueId] of pairs) {
            const skeleton = document.getElementById(skeletonId);
            const value = document.getElementById(valueId);
            if (isLoading) {
                skeleton?.classList.remove('hidden');
                value?.classList.add('hidden');
            } else {
                skeleton?.classList.add('hidden');
                value?.classList.remove('hidden');
            }
        }
    }

    /**
     * Synchronizes UI filter inputs and date range pills with `#filters`.
     */
    #syncFilterControlsUI() {
        if (typeof document === 'undefined') {
            return;
        }

        const pills = document.querySelectorAll('.date-range-pill');
        const activePillClass =
            'date-range-pill rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-blue-600 shadow-sm transition-all';
        const inactivePillClass =
            'date-range-pill rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 transition-all hover:text-slate-900';

        for (const pill of pills) {
            const range = pill.getAttribute('data-range');
            pill.className =
                range === this.#filters.dateRange ? activePillClass : inactivePillClass;
        }

        const pageSelect = document.getElementById('page-filter-select');
        const statusSelect = document.getElementById('status-filter-select');
        const searchInput = document.getElementById('search-input');

        if (pageSelect) pageSelect.value = this.#filters.pageId;
        if (statusSelect) statusSelect.value = this.#filters.status;
        if (searchInput) searchInput.value = this.#filters.search;

        this.#syncClearFiltersButton();
    }

    /**
     * Shows the "Reset Filters" button when any non-default filter is active.
     */
    #syncClearFiltersButton() {
        const clearBtn = document.getElementById('clear-filters-btn');
        if (!clearBtn) {
            return;
        }
        const hasCustomFilter =
            this.#filters.dateRange !== APP_CONFIG.dashboard.defaultDateRange ||
            this.#filters.pageId !== 'all' ||
            this.#filters.status !== 'all' ||
            this.#filters.search.trim() !== '';

        if (hasCustomFilter) {
            clearBtn.classList.remove('hidden');
        } else {
            clearBtn.classList.add('hidden');
        }
    }

    /**
     * Synchronizes sound mute/unmute button UI with RealtimeService state.
     */
    #syncSoundToggleUI() {
        const btn = document.getElementById('sound-toggle-btn');
        const label = document.getElementById('sound-toggle-label');
        if (!btn) {
            return;
        }

        const muted = this.#realtimeService.isMuted();
        btn.setAttribute('aria-pressed', muted ? 'false' : 'true');

        if (label) {
            label.textContent = muted ? 'الصوت مكتوم' : 'الصوت مفعّل';
        }

        const existingIcon = btn.querySelector('i, svg');
        const freshIcon = document.createElement('i');
        freshIcon.id = 'sound-toggle-icon';
        freshIcon.setAttribute('data-lucide', muted ? 'volume-x' : 'volume-2');
        freshIcon.setAttribute('stroke-width', '1.75');
        freshIcon.className = muted ? 'h-4 w-4 text-slate-400' : 'h-4 w-4 text-blue-600';

        if (existingIcon) {
            existingIcon.replaceWith(freshIcon);
        }
        this.#refreshIcons();
    }

    /**
     * Updates the subtle Realtime connection indicator in the top navbar.
     * @param {string} status
     */
    #updateRealtimeBadge(status) {
        const badge = document.getElementById('realtime-status-badge');
        const textEl = document.getElementById('realtime-status-text');
        if (!badge || !textEl) {
            return;
        }

        const dot = badge.querySelector('span:first-child');
        if (status === 'SUBSCRIBED') {
            badge.className =
                'hidden items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 sm:inline-flex';
            if (dot) dot.className = 'h-1.5 w-1.5 rounded-full bg-emerald-500';
            textEl.textContent = 'مباشر';
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            badge.className =
                'hidden items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 sm:inline-flex';
            if (dot) dot.className = 'h-1.5 w-1.5 rounded-full bg-amber-500';
            textEl.textContent = 'غير متصل';
        }
    }

    /**
     * Switches visible SPA shell to the Executive Login screen.
     */
    #showLoginView() {
        const boot = document.getElementById('boot-screen');
        const login = document.getElementById('login-view');
        const dash = document.getElementById('dashboard-view');

        boot?.classList.add('hidden');
        dash?.classList.add('hidden');
        dash?.classList.remove('flex');
        login?.classList.remove('hidden');
        login?.classList.add('flex');
        this.#refreshIcons();
    }

    /**
     * Switches visible SPA shell to the Authenticated Dashboard view.
     */
    #showDashboardView() {
        const boot = document.getElementById('boot-screen');
        const login = document.getElementById('login-view');
        const dash = document.getElementById('dashboard-view');

        boot?.classList.add('hidden');
        login?.classList.add('hidden');
        login?.classList.remove('flex');
        dash?.classList.remove('hidden');
        dash?.classList.add('flex');
    }

    /**
     * Displays configuration alert on the login card and disables form submission.
     * @param {string | null} message
     */
    #showConfigurationWarning(message) {
        const banner = document.getElementById('config-warning-banner');
        const textEl = document.getElementById('config-warning-text');
        const submitBtn = document.getElementById('login-submit-btn');

        if (banner && textEl) {
            textEl.textContent =
                message || 'يرجى تحديث إعدادات Supabase في js/config.js للمتابعة.';
            banner.classList.remove('hidden');
        }
        if (submitBtn) {
            submitBtn.disabled = true;
        }
    }

    /**
     * Shows an inline Arabic authentication error inside the login card.
     * @param {string} message
     */
    #showLoginError(message) {
        const alertBox = document.getElementById('login-error-alert');
        const textEl = document.getElementById('login-error-text');
        if (alertBox && textEl) {
            textEl.textContent = message;
            alertBox.classList.remove('hidden');
        }
    }

    /**
     * Hides the inline authentication error box.
     */
    #hideLoginError() {
        document.getElementById('login-error-alert')?.classList.add('hidden');
    }

    /**
     * Toggles the login submit spinner and disabled state.
     * @param {boolean} isLoading
     */
    #setLoginLoading(isLoading) {
        const submitBtn = document.getElementById('login-submit-btn');
        const spinner = document.getElementById('login-spinner');
        const label = document.getElementById('login-submit-label');

        if (submitBtn) submitBtn.disabled = Boolean(isLoading);
        if (spinner) {
            if (isLoading) {
                spinner.classList.remove('hidden');
            } else {
                spinner.classList.add('hidden');
            }
        }
        if (label) {
            label.textContent = isLoading ? 'جاري التحقق...' : 'تسجيل الدخول';
        }
    }

    /**
     * Hydrates any newly added Lucide icons across the document.
     */
    #refreshIcons() {
        try {
            if (typeof window !== 'undefined' && window.lucide?.createIcons) {
                window.lucide.createIcons({ attrs: { 'stroke-width': 1.75 } });
            }
        } catch {
            // Ignore icon hydration errors
        }
    }
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        const app = new AppController();
        app.init();
    });
}

export default AppController;
