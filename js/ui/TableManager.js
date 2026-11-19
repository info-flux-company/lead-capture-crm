/**
 * ============================================================================
 * Actionable Mini-CRM Table & Modal Manager
 * ============================================================================
 * Renders leads cleanly using document.createElement + .textContent (strict XSS
 * protection), transforms into responsive cards on mobile via CSS container
 * queries, enforces owner-only delete controls in the DOM, and manages native
 * <dialog closedby="any"> modals with mandatory Safari light-dismiss fallback.
 * ============================================================================
 */

import { LEAD_STATUSES } from '../config.js';
import SecurityUtils from '../utils/SecurityUtils.js';

/**
 * Manages the leads CRM table, pagination controls, and Notes/Delete modals.
 */
export class TableManager {
    /** @type {'owner' | 'sales'} */
    #role = 'sales';

    /** @type {Map<string, { lead: Record<string, any>, row: HTMLTableRowElement }>} */
    #leadRows = new Map();

    /** @type {Record<string, any> | null} */
    #activeNotesLead = null;

    /** @type {Record<string, any> | null} */
    #activeDeleteLead = null;

    /** @type {{ onStatusChange?: Function, onSaveNotes?: Function, onDeleteLead?: Function, onPageChange?: Function, onNotify?: Function }} */
    #callbacks;

    /** @type {{ page: number, totalPages: number, totalCount: number, pageSize: number }} */
    #pagination = { page: 1, totalPages: 1, totalCount: 0, pageSize: 25 };

    /**
     * @param {{
     *   onStatusChange?: (lead: Record<string, any>, newStatus: string, revert: () => void) => Promise<void> | void,
     *   onSaveNotes?: (lead: Record<string, any>, notes: string) => Promise<void> | void,
     *   onDeleteLead?: (lead: Record<string, any>) => Promise<void> | void,
     *   onPageChange?: (nextPage: number) => void,
     *   onNotify?: (opts: { type: 'success' | 'error' | 'info', title: string, message?: string }) => void
     * }} [callbacks]
     */
    constructor(callbacks = {}) {
        this.#callbacks = callbacks;
        this.#bindModalAndPaginationEvents();
    }

    /**
     * Updates the current user role so owner-only row actions render strictly for owners.
     * @param {'owner' | 'sales'} role
     */
    setRole(role) {
        this.#role = role === 'owner' ? 'owner' : 'sales';
    }

    /**
     * Returns whether a lead is currently rendered in the table map.
     * @param {string} leadId
     * @returns {boolean}
     */
    hasLead(leadId) {
        return this.#leadRows.has(leadId);
    }

    /**
     * Returns a cached lead object by ID if present.
     * @param {string} leadId
     * @returns {Record<string, any> | null}
     */
    getLeadById(leadId) {
        return this.#leadRows.get(leadId)?.lead || null;
    }

    /**
     * Renders animated skeleton placeholder rows while fetching leads.
     * @param {number} [count]
     */
    renderSkeleton(count = 6) {
        if (typeof document === 'undefined') {
            return;
        }

        const tbody = document.getElementById('leads-table-body');
        const table = document.getElementById('leads-table');
        const emptyState = document.getElementById('leads-empty-state');
        if (!tbody) {
            return;
        }

        emptyState?.classList.add('hidden');
        emptyState?.classList.remove('flex');
        table?.classList.remove('hidden');

        const fragment = document.createDocumentFragment();
        for (let i = 0; i < count; i += 1) {
            const tr = document.createElement('tr');
            tr.className = 'bg-white';

            const th = document.createElement('th');
            th.scope = 'row';
            th.className = 'px-4 py-4';
            const thBar = document.createElement('div');
            thBar.className = 'skeleton-shimmer h-4 w-28 rounded-md';
            th.appendChild(thBar);
            tr.appendChild(th);

            const widths = ['w-24', 'w-28', 'w-20', 'w-24', 'w-24', 'w-28'];
            for (const w of widths) {
                const td = document.createElement('td');
                td.className = 'px-4 py-4';
                const bar = document.createElement('div');
                bar.className = `skeleton-shimmer h-4 ${w} rounded-md`;
                td.appendChild(bar);
                tr.appendChild(td);
            }

            fragment.appendChild(tr);
        }

        tbody.replaceChildren(fragment);
    }

    /**
     * Renders the full current page of leads and updates pagination UI.
     * @param {Array<Record<string, any>>} leads
     * @param {{ page?: number, totalPages?: number, totalCount?: number, pageSize?: number }} [paginationMeta]
     */
    renderLeads(leads, paginationMeta = {}) {
        if (typeof document === 'undefined') {
            return;
        }

        const tbody = document.getElementById('leads-table-body');
        const table = document.getElementById('leads-table');
        const emptyState = document.getElementById('leads-empty-state');
        if (!tbody) {
            return;
        }

        this.#leadRows.clear();
        const safeLeads = Array.isArray(leads) ? leads : [];
        this.renderPagination(paginationMeta);

        if (safeLeads.length === 0) {
            tbody.replaceChildren();
            table?.classList.add('hidden');
            emptyState?.classList.remove('hidden');
            emptyState?.classList.add('flex');
            this.#hydrateIcons();
            return;
        }

        emptyState?.classList.add('hidden');
        emptyState?.classList.remove('flex');
        table?.classList.remove('hidden');

        const fragment = document.createDocumentFragment();
        for (const lead of safeLeads) {
            if (!lead?.id) {
                continue;
            }
            const row = this.#createLeadRow(lead);
            this.#leadRows.set(lead.id, { lead, row });
            fragment.appendChild(row);
        }

        tbody.replaceChildren(fragment);
        this.#hydrateIcons();
    }

    /**
     * Prepends a newly arrived Realtime lead to the top of the table with a soft blue flash.
     * @param {Record<string, any>} lead
     * @param {number} [maxRows]
     */
    prependRealtimeLead(lead, maxRows = 25) {
        if (typeof document === 'undefined' || !lead?.id || this.#leadRows.has(lead.id)) {
            return;
        }

        const tbody = document.getElementById('leads-table-body');
        const table = document.getElementById('leads-table');
        const emptyState = document.getElementById('leads-empty-state');
        if (!tbody) {
            return;
        }

        emptyState?.classList.add('hidden');
        emptyState?.classList.remove('flex');
        table?.classList.remove('hidden');

        const row = this.#createLeadRow(lead, { highlight: true });
        this.#leadRows.set(lead.id, { lead, row });
        tbody.prepend(row);

        while (tbody.children.length > maxRows) {
            const lastRow = tbody.lastElementChild;
            if (!lastRow) {
                break;
            }
            const lastId = lastRow.getAttribute('data-lead-id');
            if (lastId) {
                this.#leadRows.delete(lastId);
            }
            tbody.removeChild(lastRow);
        }

        this.#pagination.totalCount = Math.max(1, Number(this.#pagination.totalCount || 0) + 1);
        this.#pagination.totalPages = Math.max(
            1,
            Math.ceil(this.#pagination.totalCount / (this.#pagination.pageSize || 25))
        );
        this.renderPagination(this.#pagination);
        this.#hydrateIcons();
    }

    /**
     * Refreshes all visible Arabic relative timestamps without re-rendering rows.
     */
    updateRelativeTimestamps() {
        if (typeof document === 'undefined') {
            return;
        }
        const nodes = document.querySelectorAll('[data-relative-time="true"]');
        for (const el of nodes) {
            const iso = el.getAttribute('data-iso');
            if (iso) {
                el.textContent = SecurityUtils.formatRelativeTimeArabic(iso);
            }
        }
    }

    /**
     * Updates the pagination summary, indicator, and prev/next buttons.
     * @param {{ page?: number, totalPages?: number, totalCount?: number, pageSize?: number }} meta
     */
    renderPagination(meta = {}) {
        const page = Math.max(1, Number(meta.page ?? this.#pagination.page) || 1);
        const pageSize = Math.max(1, Number(meta.pageSize ?? this.#pagination.pageSize) || 25);
        const totalCount = Math.max(0, Number(meta.totalCount ?? this.#pagination.totalCount) || 0);
        const totalPages = Math.max(
            1,
            Number(meta.totalPages ?? Math.ceil(totalCount / pageSize)) || 1
        );

        this.#pagination = { page, totalPages, totalCount, pageSize };

        if (typeof document === 'undefined') {
            return;
        }

        const badgeEl = document.getElementById('leads-count-badge');
        const summaryEl = document.getElementById('pagination-summary');
        const indicatorEl = document.getElementById('pagination-indicator');
        const prevBtn = document.getElementById('pagination-prev-btn');
        const nextBtn = document.getElementById('pagination-next-btn');

        if (badgeEl) {
            badgeEl.textContent = totalCount.toLocaleString('en-US');
        }

        if (summaryEl) {
            if (totalCount === 0) {
                summaryEl.textContent = 'عرض 0 من أصل 0';
            } else {
                const start = (page - 1) * pageSize + 1;
                const end = Math.min(totalCount, page * pageSize);
                summaryEl.textContent = `عرض ${start}–${end} من أصل ${totalCount.toLocaleString('en-US')}`;
            }
        }

        if (indicatorEl) {
            indicatorEl.textContent = `${page} / ${totalPages}`;
        }

        if (prevBtn) {
            prevBtn.disabled = page <= 1;
        }
        if (nextBtn) {
            nextBtn.disabled = page >= totalPages;
        }
    }

    /**
     * Creates a single XSS-safe lead table row (`<tr>` / mobile card).
     * @param {Record<string, any>} lead
     * @param {{ highlight?: boolean }} [options]
     * @returns {HTMLTableRowElement}
     */
    #createLeadRow(lead, { highlight = false } = {}) {
        const tr = document.createElement('tr');
        tr.setAttribute('data-lead-id', lead.id);
        tr.className = `group transition-colors hover:bg-slate-50/75 ${
            highlight ? 'lead-row-flash' : ''
        }`;

        // 1. Client Name & Page Pill (<th scope="row">)
        const thName = document.createElement('th');
        thName.scope = 'row';
        thName.className = 'px-4 py-3.5 text-right font-normal align-middle';

        const nameEl = document.createElement('div');
        nameEl.className = 'text-sm font-semibold text-slate-900';
        nameEl.textContent = lead.name || 'بدون اسم';
        thName.appendChild(nameEl);

        const pageTitle = lead.pages?.title || lead.pages?.slug || '';
        if (pageTitle) {
            const pageTag = document.createElement('span');
            pageTag.className =
                'mt-1 inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600';
            pageTag.textContent = pageTitle;
            thName.appendChild(pageTag);
        }
        tr.appendChild(thName);

        // 2. Phone Number + Copy Action
        const tdPhone = document.createElement('td');
        tdPhone.className = 'px-4 py-3.5 align-middle';

        const phoneWrap = document.createElement('div');
        phoneWrap.className = 'inline-flex items-center gap-1.5';

        const phoneSpan = document.createElement('span');
        phoneSpan.dir = 'ltr';
        phoneSpan.className = 'tabular-nums text-sm font-medium text-slate-800';
        phoneSpan.textContent = lead.phone || '--';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.title = 'نسخ رقم الهاتف';
        copyBtn.setAttribute('aria-label', 'نسخ رقم الهاتف');
        copyBtn.className =
            'rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-blue-600 focus:outline-none';
        const copyIcon = document.createElement('i');
        copyIcon.setAttribute('data-lucide', 'copy');
        copyIcon.setAttribute('stroke-width', '1.75');
        copyIcon.className = 'h-3.5 w-3.5';
        copyBtn.appendChild(copyIcon);
        copyBtn.addEventListener('click', () => this.#copyPhone(lead.phone));

        phoneWrap.appendChild(phoneSpan);
        phoneWrap.appendChild(copyBtn);
        tdPhone.appendChild(phoneWrap);
        tr.appendChild(tdPhone);

        // 3. City & UTM Source
        const tdGeo = document.createElement('td');
        tdGeo.className = 'px-4 py-3.5 align-middle';

        const geoWrap = document.createElement('div');
        geoWrap.className = 'flex flex-col items-end gap-1 md:items-start';

        const rawCity = typeof lead.city === 'string' ? lead.city.trim() : '';
        const cityDisplay = !rawCity || rawCity.toLowerCase() === 'unknown' ? 'غير محدد' : rawCity;
        const cityEl = document.createElement('span');
        cityEl.className = 'inline-flex items-center gap-1 text-xs font-medium text-slate-700';
        const pinIcon = document.createElement('i');
        pinIcon.setAttribute('data-lucide', 'map-pin');
        pinIcon.setAttribute('stroke-width', '1.75');
        pinIcon.className = 'h-3.5 w-3.5 text-slate-400';
        const cityText = document.createElement('span');
        cityText.textContent = cityDisplay;
        cityEl.appendChild(pinIcon);
        cityEl.appendChild(cityText);

        const rawUtm = typeof lead.utm_source === 'string' ? lead.utm_source.trim() : '';
        const utmDisplay = !rawUtm || rawUtm.toLowerCase() === 'direct' ? 'مباشر' : rawUtm;
        const utmBadge = document.createElement('span');
        utmBadge.className =
            'inline-flex items-center rounded-md border border-blue-100 bg-blue-50/70 px-2 py-0.5 text-[11px] font-medium text-blue-700';
        utmBadge.textContent = utmDisplay;

        geoWrap.appendChild(cityEl);
        geoWrap.appendChild(utmBadge);
        tdGeo.appendChild(geoWrap);
        tr.appendChild(tdGeo);

        // 4. Relative Timestamp + Exact Tooltip
        const tdTime = document.createElement('td');
        tdTime.className = 'px-4 py-3.5 align-middle whitespace-nowrap';

        const timeSpan = document.createElement('span');
        timeSpan.setAttribute('data-relative-time', 'true');
        timeSpan.setAttribute('data-iso', lead.created_at || '');
        timeSpan.className = 'tabular-nums text-xs font-medium text-slate-600 cursor-default';
        timeSpan.textContent = SecurityUtils.formatRelativeTimeArabic(lead.created_at);
        timeSpan.title = SecurityUtils.formatExactTimestampArabic(lead.created_at);
        tdTime.appendChild(timeSpan);
        tr.appendChild(tdTime);

        // 5. Interactive Semantic Status Pill & Select
        const tdStatus = document.createElement('td');
        tdStatus.className = 'px-4 py-3.5 align-middle';

        const statusMeta = LEAD_STATUSES[lead.status] || LEAD_STATUSES.new;
        const statusWrap = document.createElement('div');
        statusWrap.className = `inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors ${statusMeta.badgeClass}`;

        const dot = document.createElement('span');
        dot.className = `h-2 w-2 shrink-0 rounded-full ${statusMeta.dotClass} ${
            statusMeta.pulse ? 'status-dot-pulse' : ''
        }`;

        const statusSelect = document.createElement('select');
        statusSelect.setAttribute('aria-label', 'تغيير حالة الطلب');
        statusSelect.className =
            'bg-transparent text-xs font-semibold focus:outline-none cursor-pointer pr-0.5';

        for (const [key, def] of Object.entries(LEAD_STATUSES)) {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = def.label;
            opt.className = 'bg-white text-slate-900';
            if (key === statusMeta.key) {
                opt.selected = true;
            }
            statusSelect.appendChild(opt);
        }

        const applyStatusStyles = (statusKey) => {
            const def = LEAD_STATUSES[statusKey] || LEAD_STATUSES.new;
            statusWrap.className = `inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors ${def.badgeClass}`;
            dot.className = `h-2 w-2 shrink-0 rounded-full ${def.dotClass} ${
                def.pulse ? 'status-dot-pulse' : ''
            }`;
            statusSelect.value = def.key;
        };

        statusSelect.addEventListener('change', async () => {
            const previousStatus = lead.status;
            const nextStatus = statusSelect.value;
            if (nextStatus === previousStatus) {
                return;
            }

            // Optimistic UI update
            lead.status = nextStatus;
            applyStatusStyles(nextStatus);

            const revert = () => {
                lead.status = previousStatus;
                applyStatusStyles(previousStatus);
            };

            if (typeof this.#callbacks.onStatusChange === 'function') {
                await this.#callbacks.onStatusChange(lead, nextStatus, revert);
            }
        });

        statusWrap.appendChild(dot);
        statusWrap.appendChild(statusSelect);
        tdStatus.appendChild(statusWrap);
        tr.appendChild(tdStatus);

        // 6. Notes Preview & Modal Trigger
        const tdNotes = document.createElement('td');
        tdNotes.className = 'px-4 py-3.5 align-middle max-w-[13rem]';

        const notesBtn = document.createElement('button');
        notesBtn.type = 'button';
        notesBtn.setAttribute('data-notes-trigger', 'true');
        notesBtn.className =
            'inline-flex max-w-full items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50/70 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-blue-200 hover:bg-blue-50/60 hover:text-blue-700';

        const notesIcon = document.createElement('i');
        notesIcon.setAttribute('stroke-width', '1.75');
        notesIcon.className = 'h-3.5 w-3.5 shrink-0';

        const notesLabel = document.createElement('span');
        notesLabel.className = 'truncate max-w-[9.5rem]';

        this.#syncNotesButtonUI(notesBtn, notesIcon, notesLabel, lead.notes || '');

        notesBtn.appendChild(notesIcon);
        notesBtn.appendChild(notesLabel);
        notesBtn.addEventListener('click', () => this.#openNotesModal(lead));
        tdNotes.appendChild(notesBtn);
        tr.appendChild(tdNotes);

        // 7. Quick Actions (WhatsApp + Call + Owner-only Delete)
        const tdActions = document.createElement('td');
        tdActions.className = 'px-4 py-3.5 align-middle text-left';

        const actionsGroup = document.createElement('div');
        actionsGroup.className = `crm-actions-group inline-flex items-center justify-end gap-1.5 ${
            this.#role === 'owner' ? 'has-delete' : ''
        }`;

        const waUrl = SecurityUtils.buildWhatsAppUrl(lead.phone, lead.name);
        if (waUrl) {
            const waLink = document.createElement('a');
            waLink.href = waUrl;
            waLink.target = '_blank';
            waLink.rel = 'noopener noreferrer';
            waLink.title = 'مراسلة عبر واتساب';
            waLink.className =
                'inline-flex items-center justify-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-600 hover:text-white';
            const waIcon = document.createElement('i');
            waIcon.setAttribute('data-lucide', 'message-circle');
            waIcon.setAttribute('stroke-width', '1.75');
            waIcon.className = 'h-3.5 w-3.5 shrink-0';
            const waText = document.createElement('span');
            waText.textContent = 'واتساب';
            waLink.appendChild(waIcon);
            waLink.appendChild(waText);
            actionsGroup.appendChild(waLink);
        }

        const telUrl = SecurityUtils.buildTelUrl(lead.phone);
        if (telUrl) {
            const callLink = document.createElement('a');
            callLink.href = telUrl;
            callLink.title = 'اتصال هاتفي مباشر';
            callLink.className =
                'inline-flex items-center justify-center gap-1 rounded-xl border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-600 hover:text-white';
            const callIcon = document.createElement('i');
            callIcon.setAttribute('data-lucide', 'phone');
            callIcon.setAttribute('stroke-width', '1.75');
            callIcon.className = 'h-3.5 w-3.5 shrink-0';
            const callText = document.createElement('span');
            callText.textContent = 'اتصال';
            callLink.appendChild(callIcon);
            callLink.appendChild(callText);
            actionsGroup.appendChild(callLink);
        }

        // Anti-data-theft: Delete button is NEVER mounted in DOM for 'sales' role
        if (this.#role === 'owner') {
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.title = 'حذف الطلب';
            delBtn.setAttribute('aria-label', 'حذف الطلب');
            delBtn.className =
                'inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white p-1.5 text-slate-400 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600';
            const delIcon = document.createElement('i');
            delIcon.setAttribute('data-lucide', 'trash-2');
            delIcon.setAttribute('stroke-width', '1.75');
            delIcon.className = 'h-3.5 w-3.5';
            delBtn.appendChild(delIcon);
            delBtn.addEventListener('click', () => this.#openDeleteModal(lead));
            actionsGroup.appendChild(delBtn);
        }

        tdActions.appendChild(actionsGroup);
        tr.appendChild(tdActions);

        return tr;
    }

    /**
     * Updates a row's Notes trigger preview text and icon cleanly.
     * @param {HTMLElement} btn
     * @param {HTMLElement} icon
     * @param {HTMLElement} label
     * @param {string} notes
     */
    #syncNotesButtonUI(btn, icon, label, notes) {
        const clean = typeof notes === 'string' ? notes.trim() : '';
        if (clean) {
            icon.setAttribute('data-lucide', 'sticky-note');
            label.textContent = clean;
            btn.title = clean;
            btn.className =
                'inline-flex max-w-full items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50/70 px-2.5 py-1.5 text-xs font-medium text-blue-800 transition-colors hover:bg-blue-100/70';
        } else {
            icon.setAttribute('data-lucide', 'file-pen-line');
            label.textContent = 'إضافة ملاحظة';
            btn.title = 'إضافة ملاحظة';
            btn.className =
                'inline-flex max-w-full items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50/70 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-blue-200 hover:bg-blue-50/60 hover:text-blue-700';
        }
    }

    /**
     * Copies a phone number to clipboard with user notification feedback.
     * @param {string} phone
     */
    async #copyPhone(phone) {
        const clean = SecurityUtils.sanitizePhone(phone);
        if (!clean) {
            return;
        }
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(clean);
                this.#callbacks.onNotify?.({
                    type: 'success',
                    title: 'تم النسخ',
                    message: `تم نسخ رقم الهاتف ${clean}`
                });
            }
        } catch {
            this.#callbacks.onNotify?.({
                type: 'error',
                title: 'تعذر النسخ',
                message: 'يرجى نسخ الرقم يدوياً.'
            });
        }
    }

    /**
     * Binds modal forms, Safari light-dismiss fallbacks, and pagination controls.
     */
    #bindModalAndPaginationEvents() {
        if (typeof document === 'undefined') {
            return;
        }

        // Pagination buttons
        const prevBtn = document.getElementById('pagination-prev-btn');
        const nextBtn = document.getElementById('pagination-next-btn');
        prevBtn?.addEventListener('click', () => {
            if (this.#pagination.page > 1) {
                this.#callbacks.onPageChange?.(this.#pagination.page - 1);
            }
        });
        nextBtn?.addEventListener('click', () => {
            if (this.#pagination.page < this.#pagination.totalPages) {
                this.#callbacks.onPageChange?.(this.#pagination.page + 1);
            }
        });

        // Notes Modal
        const notesModal = document.getElementById('notes-modal');
        const notesForm = document.getElementById('notes-modal-form');
        const notesTextarea = document.getElementById('notes-textarea');
        const notesCharCount = document.getElementById('notes-char-count');
        const notesCancelBtn = document.getElementById('notes-cancel-btn');
        const notesCloseX = document.getElementById('notes-close-x');
        const notesSaveBtn = document.getElementById('notes-save-btn');

        this.#attachLightDismissFallback(notesModal);
        notesCancelBtn?.addEventListener('click', () => notesModal?.close());
        notesCloseX?.addEventListener('click', () => notesModal?.close());

        notesTextarea?.addEventListener('input', () => {
            if (notesCharCount) {
                notesCharCount.textContent = `${notesTextarea.value.length} / 2000`;
            }
        });

        notesModal?.addEventListener('close', () => {
            this.#activeNotesLead = null;
        });

        notesForm?.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!this.#activeNotesLead || !notesTextarea) {
                return;
            }
            const targetLead = this.#activeNotesLead;
            const newNotes = notesTextarea.value.trim().slice(0, 2000);

            if (notesSaveBtn) {
                notesSaveBtn.disabled = true;
            }

            try {
                await this.#callbacks.onSaveNotes?.(targetLead, newNotes);
                targetLead.notes = newNotes;
                this.#updateRowNotesUI(targetLead.id, newNotes);
                notesModal?.close();
            } finally {
                if (notesSaveBtn) {
                    notesSaveBtn.disabled = false;
                }
            }
        });

        // Delete Modal
        const deleteModal = document.getElementById('delete-modal');
        const deleteCancelBtn = document.getElementById('delete-cancel-btn');
        const deleteConfirmBtn = document.getElementById('delete-confirm-btn');

        this.#attachLightDismissFallback(deleteModal);
        deleteCancelBtn?.addEventListener('click', () => deleteModal?.close());

        deleteModal?.addEventListener('close', () => {
            this.#activeDeleteLead = null;
        });

        deleteConfirmBtn?.addEventListener('click', async () => {
            if (!this.#activeDeleteLead || this.#role !== 'owner') {
                return;
            }
            const targetLead = this.#activeDeleteLead;
            deleteConfirmBtn.disabled = true;

            try {
                await this.#callbacks.onDeleteLead?.(targetLead);
                this.#removeLeadRow(targetLead.id);
                deleteModal?.close();
            } finally {
                deleteConfirmBtn.disabled = false;
            }
        });
    }

    /**
     * Mandatory fallback for browsers without native `<dialog closedby="any">` (e.g., Safari).
     * @param {HTMLDialogElement | null} dialog
     */
    #attachLightDismissFallback(dialog) {
        if (
            !dialog ||
            typeof HTMLDialogElement === 'undefined' ||
            'closedBy' in HTMLDialogElement.prototype
        ) {
            return;
        }

        dialog.addEventListener('click', (event) => {
            if (event.target !== dialog) {
                return;
            }
            const rect = dialog.getBoundingClientRect();
            const isDialogContent =
                rect.top <= event.clientY &&
                event.clientY <= rect.top + rect.height &&
                rect.left <= event.clientX &&
                event.clientX <= rect.left + rect.width;

            if (isDialogContent) {
                return;
            }
            dialog.close();
        });
    }

    /**
     * Opens the Notes modal populated safely via `.value` / `.textContent`.
     * @param {Record<string, any>} lead
     */
    #openNotesModal(lead) {
        const modal = document.getElementById('notes-modal');
        const infoEl = document.getElementById('notes-modal-lead-info');
        const textarea = document.getElementById('notes-textarea');
        const charCount = document.getElementById('notes-char-count');
        if (!modal || !textarea) {
            return;
        }

        this.#activeNotesLead = lead;
        if (infoEl) {
            infoEl.textContent = `${lead.name || ''} • ${lead.phone || ''}`;
        }
        textarea.value = lead.notes || '';
        if (charCount) {
            charCount.textContent = `${textarea.value.length} / 2000`;
        }

        if (typeof modal.showModal === 'function') {
            modal.showModal();
        }
        textarea.focus();
    }

    /**
     * Opens the owner-only Delete confirmation modal safely via `.textContent`.
     * @param {Record<string, any>} lead
     */
    #openDeleteModal(lead) {
        if (this.#role !== 'owner') {
            return;
        }
        const modal = document.getElementById('delete-modal');
        const infoEl = document.getElementById('delete-modal-lead-info');
        if (!modal) {
            return;
        }

        this.#activeDeleteLead = lead;
        if (infoEl) {
            infoEl.textContent = `${lead.name || ''} — ${lead.phone || ''}`;
        }

        if (typeof modal.showModal === 'function') {
            modal.showModal();
        }
    }

    /**
     * Updates the notes button preview on an existing table row after saving.
     * @param {string} leadId
     * @param {string} newNotes
     */
    #updateRowNotesUI(leadId, newNotes) {
        const entry = this.#leadRows.get(leadId);
        if (!entry) {
            return;
        }
        const btn = entry.row.querySelector('[data-notes-trigger="true"]');
        if (!btn) {
            return;
        }
        const icon = btn.querySelector('i, svg');
        const label = btn.querySelector('span');
        if (icon && label) {
            // Recreate <i> if Lucide already converted it to <svg>
            let targetIcon = icon;
            if (icon.tagName.toLowerCase() === 'svg') {
                const freshIcon = document.createElement('i');
                freshIcon.setAttribute('stroke-width', '1.75');
                freshIcon.className = 'h-3.5 w-3.5 shrink-0';
                icon.replaceWith(freshIcon);
                targetIcon = freshIcon;
            }
            this.#syncNotesButtonUI(btn, targetIcon, label, newNotes);
            this.#hydrateIcons();
        }
    }

    /**
     * Removes a deleted lead row from the DOM and updates empty/count states.
     * @param {string} leadId
     */
    #removeLeadRow(leadId) {
        const entry = this.#leadRows.get(leadId);
        if (entry?.row?.parentNode) {
            entry.row.parentNode.removeChild(entry.row);
        }
        this.#leadRows.delete(leadId);

        this.#pagination.totalCount = Math.max(0, Number(this.#pagination.totalCount || 0) - 1);
        this.#pagination.totalPages = Math.max(
            1,
            Math.ceil(this.#pagination.totalCount / (this.#pagination.pageSize || 25))
        );
        this.renderPagination(this.#pagination);

        const tbody = document.getElementById('leads-table-body');
        if (tbody && tbody.childElementCount === 0) {
            document.getElementById('leads-table')?.classList.add('hidden');
            const emptyState = document.getElementById('leads-empty-state');
            emptyState?.classList.remove('hidden');
            emptyState?.classList.add('flex');
        }
    }

    /**
     * Hydrates Lucide `<i data-lucide="...">` elements inside the DOM.
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

export default TableManager;
