/**
 * ============================================================================
 * Analytics Charts Manager (Chart.js v4)
 * ============================================================================
 * Manages:
 * 1. Peak Activity Hours Bar Chart (24-hour local distribution, rounded bars)
 * 2. Geo & Traffic Distribution Doughnut Chart (Top Cities / UTM Sources toggle)
 * Renders all custom legends and labels strictly via textContent (XSS-safe).
 * ============================================================================
 */

const DOUGHNUT_PALETTE = Object.freeze([
    '#2563EB', // blue-600
    '#0EA5E9', // sky-500
    '#4F46E5', // indigo-600
    '#06B6D4', // cyan-500
    '#10B981', // emerald-500
    '#F59E0B', // amber-500
    '#94A3B8' // slate-400 ('أخرى')
]);

const HOUR_LABELS = Object.freeze(
    Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`)
);

const FONT_FAMILY = "'IBM Plex Sans Arabic', system-ui, sans-serif";

/**
 * Coordinates the 2 executive Chart.js visualizations and their skeleton/empty states.
 */
export class ChartManager {
    /** @type {any | null} */
    #peakHoursChart = null;

    /** @type {any | null} */
    #distributionChart = null;

    /** @type {'cities' | 'sources'} */
    #distributionMode = 'cities';

    /** @type {{ hourlyCounts: number[], topCities: Array<{ label: string, count: number }>, topSources: Array<{ label: string, count: number }> }} */
    #lastData = {
        hourlyCounts: new Array(24).fill(0),
        topCities: [],
        topSources: []
    };

    /** @type {boolean} */
    #isLoading = false;

    constructor() {
        this.#bindDistributionToggles();
    }

    /**
     * Binds click handlers on the Cities / Sources pill toggle buttons.
     */
    #bindDistributionToggles() {
        if (typeof document === 'undefined') {
            return;
        }

        const citiesBtn = document.getElementById('dist-toggle-cities');
        const sourcesBtn = document.getElementById('dist-toggle-sources');

        if (citiesBtn) {
            citiesBtn.addEventListener('click', () => this.setDistributionMode('cities'));
        }
        if (sourcesBtn) {
            sourcesBtn.addEventListener('click', () => this.setDistributionMode('sources'));
        }
    }

    /**
     * Toggles skeleton loaders on both chart cards while analytics data is fetching.
     * @param {boolean} isLoading
     */
    setLoading(isLoading) {
        this.#isLoading = Boolean(isLoading);
        if (typeof document === 'undefined') {
            return;
        }

        const peakSkeleton = document.getElementById('peak-hours-skeleton');
        const peakEmpty = document.getElementById('peak-hours-empty');
        const peakCanvas = document.getElementById('peak-hours-chart');

        const distSkeleton = document.getElementById('distribution-skeleton');
        const distEmpty = document.getElementById('distribution-empty');
        const distCanvas = document.getElementById('distribution-chart');
        const distLegend = document.getElementById('distribution-legend');

        if (this.#isLoading) {
            peakSkeleton?.classList.remove('hidden');
            peakEmpty?.classList.add('hidden');
            peakEmpty?.classList.remove('flex');
            peakCanvas?.classList.add('hidden');

            distSkeleton?.classList.remove('hidden');
            distEmpty?.classList.add('hidden');
            distEmpty?.classList.remove('flex');
            distCanvas?.classList.add('hidden');
            if (distLegend) {
                distLegend.replaceChildren();
            }
        } else {
            peakSkeleton?.classList.add('hidden');
            distSkeleton?.classList.add('hidden');
        }
    }

    /**
     * Updates both charts with aggregated analytics data.
     * @param {{ hourlyCounts?: number[], topCities?: Array<{ label: string, count: number }>, topSources?: Array<{ label: string, count: number }> }} data
     */
    updateData({ hourlyCounts = [], topCities = [], topSources = [] } = {}) {
        const normalizedHours =
            Array.isArray(hourlyCounts) && hourlyCounts.length === 24
                ? hourlyCounts.map((n) => Number(n) || 0)
                : new Array(24).fill(0);

        this.#lastData = {
            hourlyCounts: normalizedHours,
            topCities: Array.isArray(topCities) ? topCities : [],
            topSources: Array.isArray(topSources) ? topSources : []
        };

        this.setLoading(false);
        this.#renderPeakHoursChart(this.#lastData.hourlyCounts);
        this.#renderDistributionChart();
    }

    /**
     * Switches the Doughnut chart between Top Cities and Traffic Sources without refetching DB.
     * @param {'cities' | 'sources'} mode
     */
    setDistributionMode(mode) {
        if (mode !== 'cities' && mode !== 'sources') {
            return;
        }
        this.#distributionMode = mode;

        if (typeof document !== 'undefined') {
            const citiesBtn = document.getElementById('dist-toggle-cities');
            const sourcesBtn = document.getElementById('dist-toggle-sources');
            const activeClass =
                'rounded-lg bg-white px-2.5 py-1 text-xs font-semibold text-blue-600 shadow-sm transition-all';
            const inactiveClass =
                'rounded-lg px-2.5 py-1 text-xs font-medium text-slate-600 transition-all hover:text-slate-900';

            if (citiesBtn) {
                citiesBtn.className = mode === 'cities' ? activeClass : inactiveClass;
            }
            if (sourcesBtn) {
                sourcesBtn.className = mode === 'sources' ? activeClass : inactiveClass;
            }
        }

        if (!this.#isLoading) {
            this.#renderDistributionChart();
        }
    }

    /**
     * Renders or updates the 24-hour Peak Activity Bar Chart.
     * @param {number[]} hourlyCounts
     */
    #renderPeakHoursChart(hourlyCounts) {
        if (typeof document === 'undefined') {
            return;
        }

        const canvas = document.getElementById('peak-hours-chart');
        const emptyEl = document.getElementById('peak-hours-empty');
        const summaryEl = document.getElementById('peak-hour-summary');

        const totalLeads = hourlyCounts.reduce((sum, count) => sum + count, 0);
        if (totalLeads === 0) {
            if (this.#peakHoursChart) {
                this.#peakHoursChart.destroy();
                this.#peakHoursChart = null;
            }
            canvas?.classList.add('hidden');
            emptyEl?.classList.remove('hidden');
            emptyEl?.classList.add('flex');
            if (summaryEl) {
                summaryEl.textContent = 'لا توجد طلبات';
            }
            return;
        }

        emptyEl?.classList.add('hidden');
        emptyEl?.classList.remove('flex');
        canvas?.classList.remove('hidden');

        const maxCount = Math.max(...hourlyCounts);
        const peakIndex = hourlyCounts.indexOf(maxCount);
        if (summaryEl) {
            summaryEl.textContent = `الذروة: ${HOUR_LABELS[peakIndex]} (${maxCount})`;
        }

        const ChartCtor = typeof window !== 'undefined' ? window.Chart : null;
        if (!canvas || typeof ChartCtor !== 'function') {
            return;
        }

        const barColors = hourlyCounts.map((val) =>
            val === maxCount && val > 0 ? '#2563EB' : '#93C5FD'
        );

        if (this.#peakHoursChart) {
            this.#peakHoursChart.data.datasets[0].data = hourlyCounts;
            this.#peakHoursChart.data.datasets[0].backgroundColor = barColors;
            this.#peakHoursChart.update();
            return;
        }

        this.#peakHoursChart = new ChartCtor(canvas, {
            type: 'bar',
            data: {
                labels: [...HOUR_LABELS],
                datasets: [
                    {
                        label: 'عدد الطلبات',
                        data: hourlyCounts,
                        backgroundColor: barColors,
                        hoverBackgroundColor: '#1D4ED8',
                        borderRadius: 6,
                        borderSkipped: false,
                        maxBarThickness: 22
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        rtl: true,
                        textDirection: 'rtl',
                        backgroundColor: '#0F172A',
                        titleFont: { family: FONT_FAMILY, size: 12, weight: '600' },
                        bodyFont: { family: FONT_FAMILY, size: 12 },
                        padding: 10,
                        cornerRadius: 10,
                        callbacks: {
                            title: (items) => {
                                const label = items?.[0]?.label || '';
                                return `الساعة ${label}`;
                            },
                            label: (ctx) => {
                                const val = Number(ctx.parsed?.y || 0);
                                return ` ${val} ${val === 1 ? 'طلب' : 'طلبات'}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        border: { display: false },
                        ticks: {
                            color: '#64748B',
                            font: { family: FONT_FAMILY, size: 11 },
                            maxRotation: 0,
                            autoSkip: true,
                            maxTicksLimit: 8
                        }
                    },
                    y: {
                        beginAtZero: true,
                        border: { display: false },
                        grid: { color: '#F1F5F9' },
                        ticks: {
                            precision: 0,
                            color: '#64748B',
                            font: { family: FONT_FAMILY, size: 11 }
                        }
                    }
                }
            }
        });
    }

    /**
     * Renders or updates the Cities / UTM Sources Doughnut Chart and XSS-safe legend.
     */
    #renderDistributionChart() {
        if (typeof document === 'undefined') {
            return;
        }

        const canvas = document.getElementById('distribution-chart');
        const emptyEl = document.getElementById('distribution-empty');
        const legendEl = document.getElementById('distribution-legend');

        const items =
            this.#distributionMode === 'cities'
                ? this.#lastData.topCities
                : this.#lastData.topSources;

        const total = items.reduce((sum, item) => sum + Number(item.count || 0), 0);
        if (items.length === 0 || total === 0) {
            if (this.#distributionChart) {
                this.#distributionChart.destroy();
                this.#distributionChart = null;
            }
            canvas?.classList.add('hidden');
            emptyEl?.classList.remove('hidden');
            emptyEl?.classList.add('flex');
            legendEl?.replaceChildren();
            return;
        }

        emptyEl?.classList.add('hidden');
        emptyEl?.classList.remove('flex');
        canvas?.classList.remove('hidden');

        const labels = items.map((item) => item.label);
        const counts = items.map((item) => Number(item.count || 0));
        const colors = items.map(
            (_, idx) => DOUGHNUT_PALETTE[idx % DOUGHNUT_PALETTE.length]
        );

        this.#renderLegend(legendEl, items, colors, total);

        const ChartCtor = typeof window !== 'undefined' ? window.Chart : null;
        if (!canvas || typeof ChartCtor !== 'function') {
            return;
        }

        if (this.#distributionChart) {
            this.#distributionChart.data.labels = labels;
            this.#distributionChart.data.datasets[0].data = counts;
            this.#distributionChart.data.datasets[0].backgroundColor = colors;
            this.#distributionChart.update();
            return;
        }

        this.#distributionChart = new ChartCtor(canvas, {
            type: 'doughnut',
            data: {
                labels,
                datasets: [
                    {
                        data: counts,
                        backgroundColor: colors,
                        borderColor: '#FFFFFF',
                        borderWidth: 2.5,
                        hoverOffset: 4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '68%',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        rtl: true,
                        textDirection: 'rtl',
                        backgroundColor: '#0F172A',
                        titleFont: { family: FONT_FAMILY, size: 12, weight: '600' },
                        bodyFont: { family: FONT_FAMILY, size: 12 },
                        padding: 10,
                        cornerRadius: 10,
                        callbacks: {
                            label: (ctx) => {
                                const val = Number(ctx.parsed || 0);
                                const pct = total > 0 ? Math.round((val / total) * 100) : 0;
                                return ` ${ctx.label}: ${val} (${pct}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    /**
     * Builds the ranked custom legend safely using createElement + textContent.
     * @param {HTMLElement | null} legendEl
     * @param {Array<{ label: string, count: number }>} items
     * @param {string[]} colors
     * @param {number} total
     */
    #renderLegend(legendEl, items, colors, total) {
        if (!legendEl) {
            return;
        }
        const fragment = document.createDocumentFragment();

        items.forEach((item, index) => {
            const li = document.createElement('li');
            li.className =
                'flex items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-xs hover:bg-slate-50 transition-colors';

            const left = document.createElement('div');
            left.className = 'flex min-w-0 items-center gap-2';

            const swatch = document.createElement('span');
            swatch.className = 'h-2.5 w-2.5 shrink-0 rounded-full';
            swatch.style.backgroundColor = colors[index];

            const labelEl = document.createElement('span');
            labelEl.className = 'truncate font-medium text-slate-700';
            labelEl.textContent = item.label;
            labelEl.title = item.label;

            left.appendChild(swatch);
            left.appendChild(labelEl);

            const pct = total > 0 ? Math.round((Number(item.count || 0) / total) * 100) : 0;
            const statsEl = document.createElement('span');
            statsEl.className = 'tabular-nums shrink-0 font-semibold text-slate-900';
            statsEl.textContent = `${item.count} (${pct}%)`;

            li.appendChild(left);
            li.appendChild(statsEl);
            fragment.appendChild(li);
        });

        legendEl.replaceChildren(fragment);
    }

    /**
     * Destroys Chart.js instances on sign-out to prevent memory leaks.
     */
    destroy() {
        if (this.#peakHoursChart) {
            this.#peakHoursChart.destroy();
            this.#peakHoursChart = null;
        }
        if (this.#distributionChart) {
            this.#distributionChart.destroy();
            this.#distributionChart = null;
        }
        this.#lastData = {
            hourlyCounts: new Array(24).fill(0),
            topCities: [],
            topSources: []
        };
    }
}

export default ChartManager;
