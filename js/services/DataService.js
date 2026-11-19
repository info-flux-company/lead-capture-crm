/**
 * ============================================================================
 * Parameterized Data & Analytics Service
 * ============================================================================
 * Encapsulates all Supabase JS SDK database queries and mutations:
 * - KPI metrics (Total Views, Total Leads, Conversion Rate, New Leads)
 * - 24-hour Peak Activity, Top Cities, and UTM Source aggregations
 * - Paginated, filtered, and search-sanitized Leads retrieval
 * - Role-protected owner-only Export & Delete operations
 * - Trigger-compliant status & notes updates (safe for 'sales' role)
 * ============================================================================
 */

import { APP_CONFIG, LEAD_STATUSES } from '../config.js';
import supabaseManager from '../supabaseClient.js';
import SecurityUtils from '../utils/SecurityUtils.js';

const SEARCH_DISALLOWED_REGEX = /[^\p{L}\p{N}\s+-]/gu;
const ANALYTICS_FETCH_LIMIT = 5000;
const EXPORT_BATCH_SIZE = 1000;
const EXPORT_MAX_ROWS = 10000;
const TOP_CATEGORIES_LIMIT = 6;

/**
 * Provides parameterized data access and analytics aggregation for the CRM dashboard.
 */
export class DataService {
    /** @type {import('@supabase/supabase-js').SupabaseClient | null} */
    #injectedClient;

    /**
     * @param {import('@supabase/supabase-js').SupabaseClient | null} [supabaseClient]
     */
    constructor(supabaseClient = null) {
        this.#injectedClient = supabaseClient;
    }

    /**
     * Resolves the active Supabase client lazily.
     * @returns {import('@supabase/supabase-js').SupabaseClient}
     */
    #getClient() {
        if (this.#injectedClient) {
            return this.#injectedClient;
        }
        return supabaseManager.getClient();
    }

    /**
     * Ensures a valid tenant workspace ID is supplied for every query.
     * @param {string} workspaceId
     * @returns {string}
     */
    #requireWorkspaceId(workspaceId) {
        if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
            throw new Error('معرف مساحة العمل (workspace_id) مطلوب.');
        }
        return workspaceId.trim();
    }

    /**
     * Converts a UI date range key into an ISO timestamp lower bound (or null for 'all').
     * @param {string} dateRange
     * @returns {string | null}
     */
    #resolveDateRangeStartISO(dateRange) {
        const now = new Date();
        switch (dateRange) {
            case 'today': {
                const startOfToday = new Date(now);
                startOfToday.setHours(0, 0, 0, 0);
                return startOfToday.toISOString();
            }
            case '7d':
                return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
            case '30d':
                return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
            case 'all':
            default:
                return null;
        }
    }

    /**
     * Checks whether a filter ID represents a specific entity rather than 'all'.
     * @param {unknown} value
     * @returns {boolean}
     */
    #isValidFilterId(value) {
        return typeof value === 'string' && value.trim() !== '' && value.trim() !== 'all';
    }

    /**
     * Sanitizes live search input to prevent PostgREST `.or()` filter syntax injection.
     * @param {unknown} rawSearch
     * @returns {string}
     */
    #sanitizeSearchTerm(rawSearch) {
        if (typeof rawSearch !== 'string') {
            return '';
        }
        return rawSearch
            .replace(SEARCH_DISALLOWED_REGEX, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);
    }

    /**
     * Fetches all landing pages belonging to the workspace for the filter dropdown.
     * @param {string} workspaceId
     * @returns {Promise<Array<{ id: string, slug: string, title: string, is_published: boolean }>>}
     */
    async fetchPages(workspaceId) {
        const wsId = this.#requireWorkspaceId(workspaceId);
        const client = this.#getClient();

        const { data, error } = await client
            .from('pages')
            .select('id, slug, title, is_published')
            .eq('workspace_id', wsId)
            .order('created_at', { ascending: false });

        if (error) {
            throw new Error(`تعذر تحميل قائمة الصفحات: ${error.message}`);
        }

        return Array.isArray(data) ? data : [];
    }

    /**
     * Fetches the 4 KPI dashboard metrics in parallel using head count queries.
     * @param {string} workspaceId
     * @param {{ dateRange?: string, pageId?: string }} [filters]
     * @returns {Promise<{ totalViews: number, totalLeads: number, conversionRate: number, newLeadsCount: number }>}
     */
    async fetchDashboardMetrics(workspaceId, { dateRange = '7d', pageId = 'all' } = {}) {
        const wsId = this.#requireWorkspaceId(workspaceId);
        const client = this.#getClient();
        const startISO = this.#resolveDateRangeStartISO(dateRange);
        const hasPageFilter = this.#isValidFilterId(pageId);

        let viewsQuery = client
            .from('page_views')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', wsId);

        let totalLeadsQuery = client
            .from('leads')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', wsId);

        let newLeadsQuery = client
            .from('leads')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', wsId)
            .eq('status', 'new');

        if (startISO) {
            viewsQuery = viewsQuery.gte('created_at', startISO);
            totalLeadsQuery = totalLeadsQuery.gte('created_at', startISO);
            newLeadsQuery = newLeadsQuery.gte('created_at', startISO);
        }

        if (hasPageFilter) {
            const cleanPageId = pageId.trim();
            viewsQuery = viewsQuery.eq('page_id', cleanPageId);
            totalLeadsQuery = totalLeadsQuery.eq('page_id', cleanPageId);
            newLeadsQuery = newLeadsQuery.eq('page_id', cleanPageId);
        }

        const [viewsRes, totalLeadsRes, newLeadsRes] = await Promise.all([
            viewsQuery,
            totalLeadsQuery,
            newLeadsQuery
        ]);

        if (viewsRes.error) {
            throw new Error(`تعذر تحميل إجمالي الزيارات: ${viewsRes.error.message}`);
        }
        if (totalLeadsRes.error) {
            throw new Error(`تعذر تحميل إجمالي الطلبات: ${totalLeadsRes.error.message}`);
        }
        if (newLeadsRes.error) {
            throw new Error(`تعذر تحميل الطلبات الجديدة: ${newLeadsRes.error.message}`);
        }

        const totalViews = Number(viewsRes.count || 0);
        const totalLeads = Number(totalLeadsRes.count || 0);
        const newLeadsCount = Number(newLeadsRes.count || 0);
        const conversionRate =
            totalViews > 0 ? Number(((totalLeads / totalViews) * 100).toFixed(2)) : 0;

        return {
            totalViews,
            totalLeads,
            conversionRate,
            newLeadsCount
        };
    }

    /**
     * Fetches lightweight lead timestamps, cities, and UTM sources and aggregates charts.
     * @param {string} workspaceId
     * @param {{ dateRange?: string, pageId?: string }} [filters]
     * @returns {Promise<{ rows: Array<Record<string, any>>, hourlyCounts: number[], topCities: Array<{ label: string, count: number }>, topSources: Array<{ label: string, count: number }> }>}
     */
    async fetchAnalyticsData(workspaceId, { dateRange = '7d', pageId = 'all' } = {}) {
        const wsId = this.#requireWorkspaceId(workspaceId);
        const client = this.#getClient();
        const startISO = this.#resolveDateRangeStartISO(dateRange);

        let query = client
            .from('leads')
            .select('created_at, city, country, utm_source')
            .eq('workspace_id', wsId);

        if (startISO) {
            query = query.gte('created_at', startISO);
        }

        if (this.#isValidFilterId(pageId)) {
            query = query.eq('page_id', pageId.trim());
        }

        const { data, error } = await query
            .order('created_at', { ascending: false })
            .limit(ANALYTICS_FETCH_LIMIT);

        if (error) {
            throw new Error(`تعذر تحميل بيانات التحليلات: ${error.message}`);
        }

        const rows = Array.isArray(data) ? data : [];
        return {
            rows,
            ...this.aggregateAnalytics(rows)
        };
    }

    /**
     * Aggregates raw analytics rows into 24-hour local distribution, top cities, and top sources.
     * Exposed publicly so Realtime inserts can update charts in memory immediately.
     * @param {Array<{ created_at?: string, city?: string, utm_source?: string }>} [rows]
     * @returns {{ hourlyCounts: number[], topCities: Array<{ label: string, count: number }>, topSources: Array<{ label: string, count: number }> }}
     */
    aggregateAnalytics(rows = []) {
        const hourlyCounts = new Array(24).fill(0);
        const cityCounts = new Map();
        const sourceCounts = new Map();

        for (const row of rows) {
            if (row?.created_at) {
                const parsedDate = new Date(row.created_at);
                if (!Number.isNaN(parsedDate.getTime())) {
                    hourlyCounts[parsedDate.getHours()] += 1;
                }
            }

            const rawCity = typeof row?.city === 'string' ? row.city.trim() : '';
            const cityLabel =
                !rawCity || rawCity.toLowerCase() === 'unknown' ? 'غير محدد' : rawCity;
            cityCounts.set(cityLabel, (cityCounts.get(cityLabel) || 0) + 1);

            const rawSource = typeof row?.utm_source === 'string' ? row.utm_source.trim() : '';
            const sourceLabel =
                !rawSource || rawSource.toLowerCase() === 'direct'
                    ? 'مباشر (Direct)'
                    : rawSource;
            sourceCounts.set(sourceLabel, (sourceCounts.get(sourceLabel) || 0) + 1);
        }

        return {
            hourlyCounts,
            topCities: this.#topCategoryEntries(cityCounts, TOP_CATEGORIES_LIMIT),
            topSources: this.#topCategoryEntries(sourceCounts, TOP_CATEGORIES_LIMIT)
        };
    }

    /**
     * Converts a frequency map into sorted top-N entries plus an aggregated 'أخرى' bucket.
     * @param {Map<string, number>} countsMap
     * @param {number} limit
     * @returns {Array<{ label: string, count: number }>}
     */
    #topCategoryEntries(countsMap, limit) {
        const sorted = Array.from(countsMap.entries()).sort((a, b) => {
            if (b[1] !== a[1]) {
                return b[1] - a[1];
            }
            return a[0].localeCompare(b[0], 'ar');
        });

        const top = sorted.slice(0, limit).map(([label, count]) => ({ label, count }));
        if (sorted.length > limit) {
            const otherCount = sorted.slice(limit).reduce((sum, [, count]) => sum + count, 0);
            if (otherCount > 0) {
                top.push({ label: 'أخرى', count: otherCount });
            }
        }

        return top;
    }

    /**
     * Builds a parameterized leads query shared by paginated list fetching and CSV export.
     * @param {import('@supabase/supabase-js').SupabaseClient} client
     * @param {string} workspaceId
     * @param {string} selectColumns
     * @param {{ dateRange?: string, pageId?: string, search?: string, status?: string }} filters
     * @param {Record<string, unknown>} [selectOptions]
     */
    #buildFilteredLeadsQuery(
        client,
        workspaceId,
        selectColumns,
        { dateRange = '7d', pageId = 'all', search = '', status = 'all' } = {},
        selectOptions = undefined
    ) {
        let query = selectOptions
            ? client.from('leads').select(selectColumns, selectOptions)
            : client.from('leads').select(selectColumns);

        query = query.eq('workspace_id', workspaceId);

        const startISO = this.#resolveDateRangeStartISO(dateRange);
        if (startISO) {
            query = query.gte('created_at', startISO);
        }

        if (this.#isValidFilterId(pageId)) {
            query = query.eq('page_id', pageId.trim());
        }

        if (
            typeof status === 'string' &&
            status !== 'all' &&
            Object.prototype.hasOwnProperty.call(LEAD_STATUSES, status)
        ) {
            query = query.eq('status', status);
        }

        const safeSearch = this.#sanitizeSearchTerm(search);
        if (safeSearch) {
            const asciiPhoneSearch = SecurityUtils.normalizeArabicDigits(safeSearch);
            query = query.or(
                `name.ilike.%${safeSearch}%,phone.ilike.%${asciiPhoneSearch}%`
            );
        }

        return query;
    }

    /**
     * Fetches paginated leads for the CRM table.
     * @param {string} workspaceId
     * @param {{ dateRange?: string, pageId?: string, search?: string, status?: string, page?: number, pageSize?: number }} [options]
     * @returns {Promise<{ leads: Array<Record<string, any>>, totalCount: number, page: number, pageSize: number, totalPages: number }>}
     */
    async fetchLeads(
        workspaceId,
        {
            dateRange = '7d',
            pageId = 'all',
            search = '',
            status = 'all',
            page = 1,
            pageSize = APP_CONFIG.dashboard.pageSize
        } = {}
    ) {
        const wsId = this.#requireWorkspaceId(workspaceId);
        const client = this.#getClient();

        const safePageSize = Math.min(
            100,
            Math.max(1, Number.parseInt(String(pageSize), 10) || APP_CONFIG.dashboard.pageSize)
        );
        const safePage = Math.max(1, Number.parseInt(String(page), 10) || 1);
        const from = (safePage - 1) * safePageSize;
        const to = from + safePageSize - 1;

        const query = this.#buildFilteredLeadsQuery(
            client,
            wsId,
            'id, workspace_id, page_id, name, phone, city, country, utm_source, status, notes, created_at, pages ( id, title, slug )',
            { dateRange, pageId, search, status },
            { count: 'exact' }
        )
            .order('created_at', { ascending: false })
            .range(from, to);

        const { data, count, error } = await query;
        if (error) {
            throw new Error(`تعذر تحميل قائمة الطلبات: ${error.message}`);
        }

        const leads = Array.isArray(data) ? data : [];
        const totalCount = Number(count ?? leads.length);
        const totalPages = Math.max(1, Math.ceil(totalCount / safePageSize));

        return {
            leads,
            totalCount,
            page: safePage,
            pageSize: safePageSize,
            totalPages
        };
    }

    /**
     * Fetches all filtered leads in 1000-row batches for owner-only CSV export.
     * @param {string} workspaceId
     * @param {string} role
     * @param {{ dateRange?: string, pageId?: string, search?: string, status?: string }} [filters]
     * @returns {Promise<Array<Record<string, any>>>}
     */
    async fetchAllFilteredLeadsForExport(workspaceId, role, filters = {}) {
        if (role !== 'owner') {
            throw new Error('غير مصرح: تصدير البيانات متاح لمدير النظام (Owner) فقط.');
        }

        const wsId = this.#requireWorkspaceId(workspaceId);
        const client = this.#getClient();
        const allLeads = [];
        let offset = 0;

        while (offset < EXPORT_MAX_ROWS) {
            const to = Math.min(offset + EXPORT_BATCH_SIZE - 1, EXPORT_MAX_ROWS - 1);
            const { data, error } = await this.#buildFilteredLeadsQuery(
                client,
                wsId,
                'id, workspace_id, page_id, name, phone, city, country, utm_source, status, notes, created_at, pages ( id, title, slug )',
                filters
            )
                .order('created_at', { ascending: false })
                .range(offset, to);

            if (error) {
                throw new Error(`تعذر تصدير البيانات: ${error.message}`);
            }

            const batch = Array.isArray(data) ? data : [];
            allLeads.push(...batch);

            if (batch.length < EXPORT_BATCH_SIZE) {
                break;
            }
            offset += EXPORT_BATCH_SIZE;
        }

        return allLeads;
    }

    /**
     * Updates ONLY the lead `status` column (compliant with sales anti-theft DB trigger).
     * @param {string} leadId
     * @param {string} workspaceId
     * @param {string} newStatus
     * @returns {Promise<{ id: string, status: string }>}
     */
    async updateLeadStatus(leadId, workspaceId, newStatus) {
        const wsId = this.#requireWorkspaceId(workspaceId);
        if (!leadId || typeof leadId !== 'string') {
            throw new Error('معرف الطلب مطلوب.');
        }
        if (!Object.prototype.hasOwnProperty.call(LEAD_STATUSES, newStatus)) {
            throw new Error('حالة الطلب المحددة غير صالحة.');
        }

        const client = this.#getClient();
        const { data, error } = await client
            .from('leads')
            .update({ status: newStatus })
            .eq('id', leadId)
            .eq('workspace_id', wsId)
            .select('id, status')
            .single();

        if (error) {
            throw new Error(`تعذر تحديث حالة الطلب: ${error.message}`);
        }

        return data;
    }

    /**
     * Updates ONLY the lead `notes` column (compliant with sales anti-theft DB trigger).
     * @param {string} leadId
     * @param {string} workspaceId
     * @param {string} notes
     * @returns {Promise<{ id: string, notes: string }>}
     */
    async updateLeadNotes(leadId, workspaceId, notes) {
        const wsId = this.#requireWorkspaceId(workspaceId);
        if (!leadId || typeof leadId !== 'string') {
            throw new Error('معرف الطلب مطلوب.');
        }

        const rawNotes = typeof notes === 'string' ? notes : String(notes ?? '');
        const cleanNotes = rawNotes.trim().slice(0, 2000);

        const client = this.#getClient();
        const { data, error } = await client
            .from('leads')
            .update({ notes: cleanNotes })
            .eq('id', leadId)
            .eq('workspace_id', wsId)
            .select('id, notes')
            .single();

        if (error) {
            throw new Error(`تعذر حفظ الملاحظات: ${error.message}`);
        }

        return data;
    }

    /**
     * Deletes a spam lead. Strictly enforced for `owner` role only.
     * @param {string} leadId
     * @param {string} workspaceId
     * @param {string} role
     * @returns {Promise<boolean>}
     */
    async deleteLead(leadId, workspaceId, role) {
        if (role !== 'owner') {
            throw new Error('غير مصرح: حذف الطلبات متاح لمدير النظام (Owner) فقط.');
        }
        const wsId = this.#requireWorkspaceId(workspaceId);
        if (!leadId || typeof leadId !== 'string') {
            throw new Error('معرف الطلب مطلوب.');
        }

        const client = this.#getClient();
        const { error } = await client
            .from('leads')
            .delete()
            .eq('id', leadId)
            .eq('workspace_id', wsId);

        if (error) {
            throw new Error(`تعذر حذف الطلب: ${error.message}`);
        }

        return true;
    }
}

export default DataService;
