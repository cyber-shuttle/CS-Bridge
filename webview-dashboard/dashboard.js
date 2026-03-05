// @ts-nocheck
// Dashboard webview script — communicates with DashboardPanel via postMessage

(function () {
    const vscode = acquireVsCodeApi();

    // State
    let currentSort = { column: 'timestamp', ascending: false };
    let events = [];

    // DOM references
    const cardTotal = document.getElementById('card-total');
    const cardSuccessRate = document.getElementById('card-success-rate');
    const cardFailed = document.getElementById('card-failed');
    const cardAvgDuration = document.getElementById('card-avg-duration');
    const tableBody = document.getElementById('event-table-body');
    const filterType = document.getElementById('filter-type');
    const filterStatus = document.getElementById('filter-status');
    const filterRange = document.getElementById('filter-range');
    const refreshBtn = document.getElementById('refresh-btn');
    const exportBtn = document.getElementById('export-btn');

    // --- Messaging ---

    function getFilters() {
        const filters = {};
        if (filterType.value) { filters.event_type = filterType.value; }
        if (filterStatus.value) { filters.status = filterStatus.value; }
        if (filterRange.value) {
            const now = new Date();
            const daysAgo = new Date(now.getTime() - parseInt(filterRange.value, 10) * 86400000);
            filters.since = daysAgo.toISOString();
        }
        return filters;
    }

    function requestSummary() {
        vscode.postMessage({ type: 'requestSummary', filters: getFilters() });
    }

    function requestEvents() {
        vscode.postMessage({ type: 'requestEvents', filters: getFilters() });
    }

    function refreshData() {
        vscode.postMessage({ type: 'refreshData', filters: getFilters() });
    }

    // --- Rendering ---

    function renderSummary(summary) {
        if (!summary) { return; }
        cardTotal.textContent = String(summary.total ?? 0);

        const successRate = summary.total > 0
            ? Math.round((summary.success / summary.total) * 100)
            : 0;
        cardSuccessRate.textContent = successRate + '%';
        cardFailed.textContent = String(summary.failure ?? 0);

        if (summary.avg_duration_ms != null && summary.avg_duration_ms > 0) {
            cardAvgDuration.textContent = formatDuration(summary.avg_duration_ms);
        } else {
            cardAvgDuration.textContent = '--';
        }
    }

    function renderEvents(data) {
        events = data || [];
        sortEvents();
        renderTable();
    }

    function sortEvents() {
        const col = currentSort.column;
        const asc = currentSort.ascending;
        events.sort(function (a, b) {
            let va = a[col];
            let vb = b[col];
            if (va == null) { va = ''; }
            if (vb == null) { vb = ''; }
            if (col === 'duration_ms') {
                va = Number(va) || 0;
                vb = Number(vb) || 0;
            }
            if (va < vb) { return asc ? -1 : 1; }
            if (va > vb) { return asc ? 1 : -1; }
            return 0;
        });
    }

    function renderTable() {
        if (events.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="6" class="empty-state"><p>No events found</p></td></tr>';
            return;
        }

        let html = '';
        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            html += '<tr>'
                + '<td>' + escapeHtml(formatTimestamp(ev.timestamp)) + '</td>'
                + '<td>' + escapeHtml(formatEventType(ev.event_type)) + '</td>'
                + '<td><span class="badge badge-' + escapeHtml(ev.status) + '">' + escapeHtml(ev.status) + '</span></td>'
                + '<td>' + (ev.duration_ms != null ? escapeHtml(formatDuration(ev.duration_ms)) : '--') + '</td>'
                + '<td>' + (ev.error_message ? '<span class="error-text" title="' + escapeAttr(ev.error_message) + '">' + escapeHtml(truncate(ev.error_message, 40)) + '</span>' : '--') + '</td>'
                + '<td><span class="meta-preview" title="' + escapeAttr(JSON.stringify(ev.metadata || {})) + '">' + escapeHtml(formatMeta(ev.metadata)) + '</span></td>'
                + '</tr>';
        }
        tableBody.innerHTML = html;
    }

    // --- Formatting helpers ---

    function formatTimestamp(ts) {
        if (!ts) { return '--'; }
        try {
            const d = new Date(ts);
            return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
        } catch (_e) {
            return ts;
        }
    }

    function formatEventType(type) {
        if (!type) { return '--'; }
        return type.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    function formatDuration(ms) {
        if (ms == null) { return '--'; }
        if (ms < 1000) { return ms + 'ms'; }
        if (ms < 60000) { return (ms / 1000).toFixed(1) + 's'; }
        return (ms / 60000).toFixed(1) + 'm';
    }

    function formatMeta(meta) {
        if (!meta || typeof meta !== 'object') { return '--'; }
        var keys = Object.keys(meta);
        if (keys.length === 0) { return '--'; }
        var parts = [];
        for (var i = 0; i < Math.min(keys.length, 3); i++) {
            parts.push(keys[i] + ':' + String(meta[keys[i]]));
        }
        return parts.join(', ') + (keys.length > 3 ? '...' : '');
    }

    function truncate(str, len) {
        if (!str) { return ''; }
        return str.length > len ? str.substring(0, len) + '...' : str;
    }

    function escapeHtml(str) {
        if (str == null) { return ''; }
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
        return escapeHtml(str).replace(/'/g, '&#39;');
    }

    // --- Event handlers ---

    refreshBtn.addEventListener('click', function () {
        refreshData();
    });

    exportBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'reportMetrics' });
    });

    filterType.addEventListener('change', function () { requestSummary(); requestEvents(); });
    filterStatus.addEventListener('change', function () { requestSummary(); requestEvents(); });
    filterRange.addEventListener('change', function () { requestSummary(); requestEvents(); });

    // Table header sorting
    document.querySelectorAll('thead th[data-sort]').forEach(function (th) {
        th.addEventListener('click', function () {
            var col = th.getAttribute('data-sort');
            if (currentSort.column === col) {
                currentSort.ascending = !currentSort.ascending;
            } else {
                currentSort.column = col;
                currentSort.ascending = true;
            }
            // Update sort arrows
            document.querySelectorAll('thead th .sort-arrow').forEach(function (arrow) {
                arrow.textContent = '';
            });
            var arrow = th.querySelector('.sort-arrow');
            if (arrow) {
                arrow.textContent = currentSort.ascending ? ' \u25B2' : ' \u25BC';
            }
            sortEvents();
            renderTable();
        });
    });

    // --- Message listener ---

    window.addEventListener('message', function (event) {
        var msg = event.data;
        switch (msg.type) {
            case 'summary':
                renderSummary(msg.data);
                break;
            case 'events':
                renderEvents(msg.data);
                break;
        }
    });

    // --- Initialize ---

    requestSummary();
    requestEvents();
})();
