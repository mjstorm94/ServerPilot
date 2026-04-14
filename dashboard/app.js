/**
 * ServerPilot — Main Application Controller
 * Handles UI state, page routing, data loading, and user interactions
 */

// ============================================================
// STATE
// ============================================================
const state = {
    currentPage: 'dashboard',
    autoRefresh: true,
    refreshInterval: null,
    refreshRate: 10000, // 10 seconds
    serverInfo: null,
    processFilter: '',
    serviceFilter: '',
    serviceStatusFilter: 'all',
    eventLog: 'System',
    eventLevel: '',
    cachedData: {},
    // Monitoring / Heartbeat
    heartbeatHistory: [],
    heartbeatMaxEntries: 60,
    heartbeatChecks: 0,
    heartbeatSuccesses: 0,
    monitoringStartTime: null,
};

// ============================================================
// INITIALIZATION
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    initConnection();
    initNavigation();
    initTabs();
    initSearch();
    initFilters();
    initModals();
    initRefreshControls();
    loadSavedConnection();
});

function initConnection() {
    const form = document.getElementById('connection-form');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        await handleConnect();
    });

    document.getElementById('disconnect-btn').addEventListener('click', handleDisconnect);
}

function loadSavedConnection() {
    const saved = localStorage.getItem('serverpilot_connection');
    if (saved) {
        try {
            const conn = JSON.parse(saved);
            document.getElementById('server-host').value = conn.host || '';
            document.getElementById('server-port').value = conn.port || 8443;
            document.getElementById('api-key').value = conn.apiKey || '';
            document.getElementById('remember-connection').checked = true;
        } catch (e) { /* ignore */ }
    }
}

async function handleConnect() {
    const host = document.getElementById('server-host').value.trim();
    const port = document.getElementById('server-port').value.trim();
    const apiKey = document.getElementById('api-key').value.trim();
    const remember = document.getElementById('remember-connection').checked;
    const errorEl = document.getElementById('connection-error');
    const btn = document.getElementById('connect-btn');

    if (!host || !port || !apiKey) {
        showFormError(errorEl, 'Please fill in all fields');
        return;
    }

    // Show loading
    btn.querySelector('.btn-text').textContent = 'Connecting...';
    btn.querySelector('.btn-loader').style.display = 'inline-block';
    btn.disabled = true;
    errorEl.style.display = 'none';

    api.configure(host, port, apiKey);

    try {
        const health = await api.testConnection();
        
        if (remember) {
            localStorage.setItem('serverpilot_connection', JSON.stringify({ host, port, apiKey }));
        } else {
            localStorage.removeItem('serverpilot_connection');
        }

        // Hide modal, show app
        document.getElementById('connection-modal').classList.remove('active');
        document.getElementById('app').classList.remove('hidden');

        // Update server badge
        document.getElementById('nav-server-address').textContent = `${host}:${port}`;

        showToast('success', `Connected to server (agent v${health.version})`);
        
        // Load initial data
        await loadDashboardData();
        startAutoRefresh();

    } catch (error) {
        let msg = error.message;
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
            msg = 'Cannot reach the server. Check the address, port, and ensure the agent is running. If using HTTPS with a self-signed certificate, you may need to visit the server URL directly in your browser first and accept the certificate.';
        }
        showFormError(errorEl, msg);
    } finally {
        btn.querySelector('.btn-text').textContent = 'Connect';
        btn.querySelector('.btn-loader').style.display = 'none';
        btn.disabled = false;
    }
}

function handleDisconnect() {
    api.connected = false;
    stopAutoRefresh();
    document.getElementById('app').classList.add('hidden');
    document.getElementById('connection-modal').classList.add('active');
    state.cachedData = {};
    showToast('info', 'Disconnected from server');
}

function showFormError(el, msg) {
    el.textContent = msg;
    el.style.display = 'block';
}

// ============================================================
// NAVIGATION
// ============================================================
function initNavigation() {
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo(item.dataset.page);
        });
    });

    // Card links that navigate to pages
    document.querySelectorAll('.card-link[data-page]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo(link.dataset.page);
        });
    });
}

function navigateTo(page) {
    state.currentPage = page;

    // Update nav
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });

    // Update pages
    document.querySelectorAll('.page').forEach(p => {
        p.classList.toggle('active', p.id === `page-${page}`);
    });

    // Update top bar
    const titles = {
        dashboard: ['Dashboard', 'Overview'],
        updates: ['Windows Updates', 'Manage Updates'],
        processes: ['Processes', 'Running Applications'],
        services: ['Services', 'Windows Services'],
        events: ['Event Log', 'System Events'],
        monitoring: ['Monitoring', 'Uptime & Alerts'],
    };

    const [title, breadcrumb] = titles[page] || ['Dashboard', 'Overview'];
    document.getElementById('page-title').textContent = title;
    document.getElementById('breadcrumb').textContent = breadcrumb;

    // Load page data
    loadPageData(page);
}

// ============================================================
// TABS (Updates page)
// ============================================================
function initTabs() {
    document.querySelectorAll('.tab-bar .tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const parent = tab.closest('.page-actions') || tab.closest('.tab-bar').parentElement;
            const bar = tab.closest('.tab-bar');
            
            bar.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const tabId = tab.dataset.tab;
            const page = tab.closest('.page') || document.getElementById('page-updates');
            page.querySelectorAll('.tab-content').forEach(tc => {
                tc.classList.toggle('active', tc.id === `tab-${tabId}`);
            });

            // Load tab data
            loadTabData(tabId);
        });
    });
}

function loadTabData(tab) {
    switch (tab) {
        case 'pending': loadPendingUpdates(); break;
        case 'history': loadUpdateHistory(); break;
        case 'settings': loadUpdateSettings(); break;
        case 'schedule': loadUpdateSchedule(); break;
    }
}

// ============================================================
// SEARCH
// ============================================================
function initSearch() {
    const processSearch = document.getElementById('process-search');
    let searchTimeout;
    processSearch.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            state.processFilter = e.target.value;
            loadProcesses();
        }, 400);
    });

    const serviceSearch = document.getElementById('service-search');
    let svcSearchTimeout;
    serviceSearch.addEventListener('input', (e) => {
        clearTimeout(svcSearchTimeout);
        svcSearchTimeout = setTimeout(() => {
            state.serviceFilter = e.target.value;
            loadServices();
        }, 400);
    });
}

// ============================================================
// FILTERS
// ============================================================
function initFilters() {
    // Service status filter
    document.querySelectorAll('#page-services .chip[data-filter]').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('#page-services .chip[data-filter]').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            state.serviceStatusFilter = chip.dataset.filter;
            renderServices(state.cachedData.services);
        });
    });

    // Event log filter
    document.querySelectorAll('#page-events .chip[data-log]').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('#page-events .chip[data-log]').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            state.eventLog = chip.dataset.log;
            loadEvents();
        });
    });

    // Event level filter
    document.querySelectorAll('#page-events .chip[data-level]').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('#page-events .chip[data-level]').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            state.eventLevel = chip.dataset.level;
            loadEvents();
        });
    });
}

// ============================================================
// MODALS
// ============================================================
function initModals() {
    // Start App
    document.getElementById('start-app-btn').addEventListener('click', () => {
        openModal('start-app-modal');
    });

    document.getElementById('start-app-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const path = document.getElementById('app-path').value.trim();
        const args = document.getElementById('app-args').value.trim();
        const workdir = document.getElementById('app-workdir').value.trim();

        try {
            const result = await api.startProcess(path, args, workdir);
            if (result.success) {
                showToast('success', `Started ${result.data.name} (PID: ${result.data.pid})`);
                closeModal('start-app-modal');
                document.getElementById('start-app-form').reset();
                loadProcesses();
            } else {
                showToast('error', result.error);
            }
        } catch (error) {
            showToast('error', error.message);
        }
    });

    // Schedule
    document.getElementById('new-schedule-btn').addEventListener('click', () => {
        openModal('schedule-modal');
    });

    document.getElementById('schedule-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('schedule-name').value.trim();
        const time = document.getElementById('schedule-time').value;
        const freq = document.getElementById('schedule-frequency').value;

        try {
            const result = await api.createUpdateSchedule(name, time, freq);
            if (result.success) {
                showToast('success', `Schedule "${name}" created`);
                closeModal('schedule-modal');
                document.getElementById('schedule-form').reset();
                loadUpdateSchedule();
            } else {
                showToast('error', result.error);
            }
        } catch (error) {
            showToast('error', error.message);
        }
    });

    // Reboot
    document.getElementById('reboot-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const delay = parseInt(document.getElementById('reboot-delay').value);
        const reason = document.getElementById('reboot-reason').value.trim();

        try {
            const result = await api.scheduleReboot(delay, reason);
            if (result.success) {
                showToast('warning', `Reboot scheduled in ${delay} minutes`);
                closeModal('reboot-modal');
            } else {
                showToast('error', result.error);
            }
        } catch (error) {
            showToast('error', error.message);
        }
    });

    // Install all updates
    document.getElementById('install-all-updates-btn').addEventListener('click', async () => {
        if (!confirm('Install all pending updates? This may take a while.')) return;
        try {
            showToast('info', 'Installing updates... This may take several minutes.');
            const result = await api.installUpdates();
            if (result.success) {
                const msg = `Installed ${result.data.installed} update(s).${result.data.reboot_required ? ' Reboot required!' : ''}`;
                showToast(result.data.reboot_required ? 'warning' : 'success', msg);
                loadPendingUpdates();
            } else {
                showToast('error', result.error);
            }
        } catch (error) {
            showToast('error', error.message);
        }
    });

    // Close on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && overlay.id !== 'connection-modal') {
                overlay.classList.remove('active');
            }
        });
    });
}

function openModal(id) {
    document.getElementById(id).classList.add('active');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

// ============================================================
// REFRESH CONTROLS
// ============================================================
function initRefreshControls() {
    document.getElementById('refresh-btn').addEventListener('click', () => {
        loadPageData(state.currentPage);
        animateRefreshButton();
    });

    document.getElementById('auto-refresh-toggle').addEventListener('change', (e) => {
        state.autoRefresh = e.target.checked;
        if (state.autoRefresh) {
            startAutoRefresh();
        } else {
            stopAutoRefresh();
        }
    });
}

function startAutoRefresh() {
    stopAutoRefresh();
    if (state.autoRefresh) {
        state.refreshInterval = setInterval(() => {
            if (state.currentPage !== 'updates') {
                loadPageData(state.currentPage);
            }
        }, state.refreshRate);
    }
}

function stopAutoRefresh() {
    if (state.refreshInterval) {
        clearInterval(state.refreshInterval);
        state.refreshInterval = null;
    }
}

function animateRefreshButton() {
    const btn = document.getElementById('refresh-btn');
    btn.style.transform = 'rotate(360deg)';
    btn.style.transition = 'transform 0.5s ease';
    setTimeout(() => {
        btn.style.transform = '';
        btn.style.transition = '';
    }, 500);
}

function updateLastUpdated() {
    const now = new Date();
    document.getElementById('last-updated').textContent = 
        `Last updated: ${now.toLocaleTimeString()}`;
}

// ============================================================
// DATA LOADING
// ============================================================
async function loadPageData(page) {
    switch (page) {
        case 'dashboard': await loadDashboardData(); break;
        case 'updates': await loadPendingUpdates(); break;
        case 'processes': await loadProcesses(); break;
        case 'services': await loadServices(); break;
        case 'events': await loadEvents(); break;
        case 'monitoring': await runHeartbeatCheck(); break;
    }
    updateLastUpdated();
}

async function loadDashboardData() {
    try {
        const updatesPromise = state.cachedData.pendingUpdates
            ? Promise.resolve({ success: true, data: state.cachedData.pendingUpdates })
            : api.getPendingUpdates().then(res => {
                if (res.success) state.cachedData.pendingUpdates = res.data;
                return res;
            });

        const [sysResult, rebootResult, updatesResult, processResult] = await Promise.allSettled([
            api.getSystemInfo(),
            api.getRebootStatus(),
            updatesPromise,
            api.getProcesses(),
        ]);

        if (sysResult.status === 'fulfilled' && sysResult.value.success) {
            renderSystemStats(sysResult.value.data);
        }

        if (rebootResult.status === 'fulfilled' && rebootResult.value.success) {
            renderRebootStatus(rebootResult.value.data);
        }

        if (updatesResult.status === 'fulfilled' && updatesResult.value.success) {
            renderDashboardUpdates(updatesResult.value.data);
            // Update badge
            const count = updatesResult.value.data.count;
            const badge = document.getElementById('update-badge');
            if (count > 0) {
                badge.textContent = count;
                badge.style.display = 'inline';
            } else {
                badge.style.display = 'none';
            }
        }

        if (processResult.status === 'fulfilled' && processResult.value.success) {
            renderDashboardProcesses(processResult.value.data);
        }

        updateLastUpdated();
    } catch (error) {
        showToast('error', `Failed to load dashboard: ${error.message}`);
    }
}

// ============================================================
// RENDER: Dashboard
// ============================================================
function renderSystemStats(data) {
    state.serverInfo = data;
    document.getElementById('nav-server-name').textContent = data.hostname;

    // CPU
    const cpuUsage = Math.round(data.cpu.usage || 0);
    document.getElementById('cpu-usage').textContent = `${cpuUsage}%`;
    document.getElementById('cpu-bar').style.width = `${cpuUsage}%`;
    colorizeBar('cpu-bar', cpuUsage);

    // Memory
    const memPct = Math.round(data.memory.usage_percent);
    document.getElementById('memory-usage').textContent = 
        `${data.memory.used_gb} / ${data.memory.total_gb} GB`;
    document.getElementById('memory-bar').style.width = `${memPct}%`;

    // Disk
    if (data.disks && data.disks.length > 0) {
        const disk = data.disks[0];
        document.getElementById('disk-usage').textContent = 
            `${disk.used_gb} / ${disk.total_gb} GB`;
        document.getElementById('disk-bar').style.width = `${disk.usage_percent}%`;
    }

    // Uptime
    const uptime = data.uptime;
    let uptimeStr = '';
    if (uptime.days > 0) uptimeStr += `${uptime.days}d `;
    uptimeStr += `${uptime.hours}h ${uptime.minutes}m`;
    document.getElementById('uptime-value').textContent = uptimeStr;
    document.getElementById('os-info').textContent = data.os;
}

function colorizeBar(id, pct) {
    const bar = document.getElementById(id);
    if (pct > 90) {
        bar.style.background = 'linear-gradient(90deg, var(--accent-rose), var(--accent-amber))';
    } else if (pct > 70) {
        bar.style.background = 'linear-gradient(90deg, var(--accent-amber), var(--accent-blue))';
    } else {
        bar.style.background = 'var(--gradient-primary)';
    }
}

function renderRebootStatus(data) {
    const container = document.getElementById('dashboard-reboot');
    let html = '<div class="status-panel">';

    html += `
        <div class="status-item">
            <div class="status-item-label">
                ${data.reboot_pending 
                    ? '<span class="badge badge-warning"><span class="badge-dot"></span>Reboot Pending</span>'
                    : '<span class="badge badge-success"><span class="badge-dot"></span>No Reboot Needed</span>'}
            </div>
        </div>`;

    if (data.reboot_pending && data.reasons.length > 0) {
        html += `
        <div class="status-item">
            <div class="status-item-label">Reasons</div>
            <div>${data.reasons.map(r => `<span class="badge badge-neutral">${escHtml(r)}</span>`).join(' ')}</div>
        </div>`;
    }

    html += `
        <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="btn btn-outline btn-sm" onclick="openModal('reboot-modal')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="23 4 23 10 17 10"/>
                    <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
                </svg>
                Schedule Reboot
            </button>
            <button class="btn btn-ghost btn-sm" onclick="cancelReboot()">Cancel Reboot</button>
        </div>`;

    html += '</div>';
    container.innerHTML = html;
}

function renderDashboardUpdates(data) {
    const container = document.getElementById('dashboard-updates');

    if (data.count === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent-emerald)" stroke-width="1.5">
                    <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
                <p style="color:var(--accent-emerald-light)">System is up to date!</p>
            </div>`;
        return;
    }

    let html = '';
    const shown = data.updates.slice(0, 5);
    shown.forEach(u => {
        html += `
        <div class="update-item">
            <div class="update-info">
                <div class="update-title">
                    ${escHtml(u.title)}
                    ${severityBadge(u.severity)}
                </div>
                <div class="update-meta">
                    <span>${u.size_mb} MB</span>
                    ${u.kb_numbers.length ? `<span>KB${u.kb_numbers[0]}</span>` : ''}
                </div>
            </div>
        </div>`;
    });

    if (data.count > 5) {
        html += `<p style="text-align:center;color:var(--text-muted);font-size:0.85rem;padding:8px 0;">
            + ${data.count - 5} more updates</p>`;
    }

    container.innerHTML = html;
}

function renderDashboardProcesses(data) {
    const container = document.getElementById('dashboard-processes');

    if (!data.processes || data.processes.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No processes found</p></div>';
        return;
    }

    const top = data.processes.slice(0, 8);
    let html = `
    <table class="data-table">
        <thead>
            <tr>
                <th>Name</th>
                <th>PID</th>
                <th>Memory</th>
                <th>CPU (s)</th>
                <th>Threads</th>
                <th>Status</th>
            </tr>
        </thead>
        <tbody>`;

    top.forEach(p => {
        html += `
            <tr>
                <td><strong>${escHtml(p.name)}</strong></td>
                <td class="mono">${p.pid}</td>
                <td class="mono">${p.memory_mb} MB</td>
                <td class="mono">${p.cpu_seconds}</td>
                <td class="mono">${p.threads}</td>
                <td>${p.responding !== false 
                    ? '<span class="badge badge-success"><span class="badge-dot"></span>Running</span>' 
                    : '<span class="badge badge-warning"><span class="badge-dot"></span>Not Responding</span>'}</td>
            </tr>`;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

// ============================================================
// RENDER: Updates Page
// ============================================================
async function loadPendingUpdates() {
    const container = document.getElementById('pending-updates-list');
    if (!state.cachedData.pendingUpdates) {
        container.innerHTML = loadingHTML('Checking for updates...');
    }

    try {
        const result = await api.getPendingUpdates();
        if (result.success) {
            state.cachedData.pendingUpdates = result.data;
            renderPendingUpdates(result.data);
        } else {
            container.innerHTML = errorHTML(result.error);
        }
    } catch (error) {
        container.innerHTML = errorHTML(error.message);
    }
}

function renderPendingUpdates(data) {
    const container = document.getElementById('pending-updates-list');
    const installBtn = document.getElementById('install-all-updates-btn');

    if (data.count === 0) {
        installBtn.style.display = 'none';
        container.innerHTML = `
            <div class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent-emerald)" stroke-width="1.5">
                    <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
                <p style="color:var(--accent-emerald-light);font-size:1rem;font-weight:600;">All up to date!</p>
                <p>No pending updates found.</p>
            </div>`;
        return;
    }

    installBtn.style.display = 'inline-flex';
    let html = '';

    data.updates.forEach(u => {
        html += `
        <div class="update-item">
            <input type="checkbox" class="update-checkbox" value="${escHtml(u.id)}" checked>
            <div class="update-info">
                <div class="update-title">
                    ${escHtml(u.title)}
                    ${severityBadge(u.severity)}
                    ${u.is_downloaded ? '<span class="badge badge-info">Downloaded</span>' : ''}
                    ${u.is_mandatory ? '<span class="badge badge-warning">Mandatory</span>' : ''}
                </div>
                <div class="update-meta">
                    <span>${u.size_mb} MB</span>
                    ${u.kb_numbers.length ? `<span>KB${u.kb_numbers.join(', KB')}</span>` : ''}
                    ${u.categories.length ? `<span>${escHtml(u.categories[0])}</span>` : ''}
                    ${u.release_date ? `<span>${new Date(u.release_date).toLocaleDateString()}</span>` : ''}
                </div>
                ${u.description ? `<p style="font-size:0.82rem;color:var(--text-muted);margin-top:6px;line-height:1.5;">${escHtml(u.description.substring(0, 200))}${u.description.length > 200 ? '...' : ''}</p>` : ''}
            </div>
            <div class="update-action">
                <button class="btn btn-outline btn-sm" onclick="installSingleUpdate('${escHtml(u.id)}')">Install</button>
            </div>
        </div>`;
    });

    container.innerHTML = html;
}

async function installSingleUpdate(updateId) {
    try {
        showToast('info', 'Installing update...');
        const result = await api.installUpdates([updateId]);
        if (result.success) {
            showToast('success', `Update installed.${result.data.reboot_required ? ' Reboot required.' : ''}`);
            loadPendingUpdates();
        } else {
            showToast('error', result.error);
        }
    } catch (error) {
        showToast('error', error.message);
    }
}

async function loadUpdateHistory() {
    const container = document.getElementById('update-history-list');
    container.innerHTML = loadingHTML('Loading history...');

    try {
        const result = await api.getUpdateHistory(100);
        if (result.success) {
            renderUpdateHistory(result.data);
        } else {
            container.innerHTML = errorHTML(result.error);
        }
    } catch (error) {
        container.innerHTML = errorHTML(error.message);
    }
}

function renderUpdateHistory(data) {
    const container = document.getElementById('update-history-list');

    if (!data.history || data.history.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No update history found</p></div>';
        return;
    }

    let html = `
    <table class="data-table">
        <thead>
            <tr>
                <th>Title</th>
                <th>Date</th>
                <th>Operation</th>
                <th>Result</th>
            </tr>
        </thead>
        <tbody>`;

    data.history.forEach(h => {
        const resultClass = h.result === 'Succeeded' ? 'badge-success' 
            : h.result === 'Failed' ? 'badge-danger' 
            : 'badge-warning';

        html += `
            <tr>
                <td>${escHtml(h.title)}</td>
                <td class="mono">${new Date(h.date).toLocaleString()}</td>
                <td><span class="badge badge-neutral">${h.operation}</span></td>
                <td><span class="badge ${resultClass}">${h.result}</span></td>
            </tr>`;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

async function loadUpdateSettings() {
    const container = document.getElementById('update-settings');
    container.innerHTML = loadingHTML('Loading settings...');

    try {
        const result = await api.getUpdateSettings();
        if (result.success) {
            renderUpdateSettings(result.data);
        } else {
            container.innerHTML = errorHTML(result.error);
        }
    } catch (error) {
        container.innerHTML = errorHTML(error.message);
    }
}

function renderUpdateSettings(data) {
    const container = document.getElementById('update-settings');
    container.innerHTML = `
    <div class="settings-grid">
        <div class="setting-item">
            <div class="setting-label">Notification Level</div>
            <div class="setting-value">${escHtml(data.notification_level)}</div>
        </div>
        <div class="setting-item">
            <div class="setting-label">Scheduled Day</div>
            <div class="setting-value">${escHtml(data.scheduled_day || 'N/A')}</div>
        </div>
        <div class="setting-item">
            <div class="setting-label">Scheduled Time</div>
            <div class="setting-value">${data.scheduled_time != null ? data.scheduled_time + ':00' : 'N/A'}</div>
        </div>
        <div class="setting-item">
            <div class="setting-label">Read Only</div>
            <div class="setting-value">${data.read_only ? 'Yes' : 'No'}</div>
        </div>
    </div>
    <p style="margin-top:var(--space-md);font-size:0.82rem;color:var(--text-muted);">
        These settings are managed by Windows Update / Group Policy on the server.
    </p>`;
}

async function loadUpdateSchedule() {
    const container = document.getElementById('schedule-list');
    container.innerHTML = loadingHTML('Loading schedules...');

    try {
        const result = await api.getUpdateSchedule();
        if (result.success) {
            renderUpdateSchedule(result.data);
        } else {
            container.innerHTML = errorHTML(result.error);
        }
    } catch (error) {
        container.innerHTML = errorHTML(error.message);
    }
}

function renderUpdateSchedule(data) {
    const container = document.getElementById('schedule-list');

    if (!data.tasks || data.tasks.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/>
                    <line x1="8" y1="2" x2="8" y2="6"/>
                    <line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
                <p>No scheduled tasks. Create one to automate updates.</p>
            </div>`;
        return;
    }

    let html = `
    <table class="data-table">
        <thead>
            <tr>
                <th>Name</th>
                <th>State</th>
                <th>Last Run</th>
                <th>Next Run</th>
            </tr>
        </thead>
        <tbody>`;

    data.tasks.forEach(t => {
        html += `
            <tr>
                <td><strong>${escHtml(t.name)}</strong></td>
                <td><span class="badge ${t.state === 'Ready' ? 'badge-success' : 'badge-neutral'}">${t.state}</span></td>
                <td class="mono">${t.last_run ? new Date(t.last_run).toLocaleString() : '—'}</td>
                <td class="mono">${t.next_run ? new Date(t.next_run).toLocaleString() : '—'}</td>
            </tr>`;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

// ============================================================
// RENDER: Processes Page
// ============================================================
async function loadProcesses() {
    const container = document.getElementById('process-list');
    
    // Only show loading on first load
    if (!state.cachedData.processes) {
        container.innerHTML = loadingHTML('Loading processes...');
    }

    try {
        const result = await api.getProcesses(state.processFilter);
        if (result.success) {
            state.cachedData.processes = result.data;
            renderProcesses(result.data);
        } else {
            container.innerHTML = errorHTML(result.error);
        }
    } catch (error) {
        container.innerHTML = errorHTML(error.message);
    }
}

function renderProcesses(data) {
    const container = document.getElementById('process-list');

    if (!data.processes || data.processes.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No processes found</p></div>';
        return;
    }

    let html = `
    <table class="data-table">
        <thead>
            <tr>
                <th>Name</th>
                <th>PID</th>
                <th>Memory</th>
                <th>CPU (s)</th>
                <th>Threads</th>
                <th>Status</th>
                <th>Actions</th>
            </tr>
        </thead>
        <tbody>`;

    data.processes.forEach(p => {
        html += `
            <tr>
                <td>
                    <strong>${escHtml(p.name)}</strong>
                    ${p.title ? `<br><span style="font-size:0.78rem;color:var(--text-muted)">${escHtml(p.title)}</span>` : ''}
                </td>
                <td class="mono">${p.pid}</td>
                <td class="mono">${p.memory_mb} MB</td>
                <td class="mono">${p.cpu_seconds}</td>
                <td class="mono">${p.threads}</td>
                <td>${p.responding !== false 
                    ? '<span class="badge badge-success"><span class="badge-dot"></span>OK</span>' 
                    : '<span class="badge badge-warning"><span class="badge-dot"></span>Hung</span>'}</td>
                <td>
                    <button class="btn btn-ghost btn-sm" onclick="stopProcess(${p.pid}, '${escHtml(p.name)}', false)" title="Graceful stop">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="6" y="6" width="12" height="12" rx="1"/>
                        </svg>
                    </button>
                    <button class="btn btn-ghost btn-sm" onclick="stopProcess(${p.pid}, '${escHtml(p.name)}', true)" title="Force kill" style="color:var(--accent-rose)">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </td>
            </tr>`;
    });

    html += '</tbody></table>';
    html += `<p style="text-align:center;color:var(--text-muted);font-size:0.8rem;padding:12px 0;">
        Showing ${data.processes.length} of ${data.count} processes</p>`;
    container.innerHTML = html;
}

async function stopProcess(pid, name, force) {
    const action = force ? 'force kill' : 'stop';
    if (!confirm(`${force ? 'Force kill' : 'Stop'} process "${name}" (PID: ${pid})?`)) return;

    try {
        const result = await api.stopProcess(pid, force);
        if (result.success) {
            showToast('success', result.data.message);
            setTimeout(() => loadProcesses(), 500);
        } else {
            showToast('error', result.error);
        }
    } catch (error) {
        showToast('error', error.message);
    }
}

// ============================================================
// RENDER: Services Page
// ============================================================
async function loadServices() {
    const container = document.getElementById('service-list');

    if (!state.cachedData.services) {
        container.innerHTML = loadingHTML('Loading services...');
    }

    try {
        const result = await api.getServices(state.serviceFilter);
        if (result.success) {
            state.cachedData.services = result.data;
            renderServices(result.data);
        } else {
            container.innerHTML = errorHTML(result.error);
        }
    } catch (error) {
        container.innerHTML = errorHTML(error.message);
    }
}

function renderServices(data) {
    const container = document.getElementById('service-list');

    if (!data || !data.services || data.services.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No services found</p></div>';
        return;
    }

    let services = data.services;

    // Apply status filter
    if (state.serviceStatusFilter !== 'all') {
        services = services.filter(s => 
            s.status.toLowerCase() === state.serviceStatusFilter
        );
    }

    let html = `
    <table class="data-table">
        <thead>
            <tr>
                <th>Display Name</th>
                <th>Service Name</th>
                <th>Status</th>
                <th>Start Type</th>
                <th>Actions</th>
            </tr>
        </thead>
        <tbody>`;

    services.forEach(s => {
        const isRunning = s.status === 'Running';
        const statusBadge = isRunning 
            ? '<span class="badge badge-success"><span class="badge-dot"></span>Running</span>'
            : '<span class="badge badge-neutral"><span class="badge-dot"></span>Stopped</span>';

        html += `
            <tr>
                <td><strong>${escHtml(s.display_name)}</strong></td>
                <td class="mono">${escHtml(s.name)}</td>
                <td>${statusBadge}</td>
                <td><span class="badge badge-neutral">${escHtml(s.start_type)}</span></td>
                <td>
                    ${!isRunning ? `
                        <button class="btn btn-ghost btn-sm" onclick="controlService('${escHtml(s.name)}', 'start')" title="Start" style="color:var(--accent-emerald)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polygon points="5 3 19 12 5 21 5 3"/>
                            </svg>
                        </button>` : ''}
                    ${isRunning && s.can_stop ? `
                        <button class="btn btn-ghost btn-sm" onclick="controlService('${escHtml(s.name)}', 'stop')" title="Stop" style="color:var(--accent-rose)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="6" y="6" width="12" height="12" rx="1"/>
                            </svg>
                        </button>` : ''}
                    ${isRunning && s.can_stop ? `
                        <button class="btn btn-ghost btn-sm" onclick="controlService('${escHtml(s.name)}', 'restart')" title="Restart" style="color:var(--accent-amber)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="23 4 23 10 17 10"/>
                                <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
                            </svg>
                        </button>` : ''}
                </td>
            </tr>`;
    });

    html += '</tbody></table>';
    html += `<p style="text-align:center;color:var(--text-muted);font-size:0.8rem;padding:12px 0;">
        Showing ${services.length} services</p>`;
    container.innerHTML = html;
}

async function controlService(name, action) {
    if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} service "${name}"?`)) return;

    try {
        showToast('info', `${action}ing service "${name}"...`);
        const result = await api.controlService(name, action);
        if (result.success) {
            showToast('success', `Service "${name}" is now ${result.data.status}`);
            setTimeout(() => loadServices(), 500);
        } else {
            showToast('error', result.error);
        }
    } catch (error) {
        showToast('error', error.message);
    }
}

// ============================================================
// RENDER: Events Page
// ============================================================
async function loadEvents() {
    const container = document.getElementById('event-list');
    container.innerHTML = loadingHTML('Loading events...');

    try {
        const result = await api.getEvents(state.eventLog, 50, state.eventLevel);
        if (result.success) {
            renderEvents(result.data);
        } else {
            container.innerHTML = errorHTML(result.error);
        }
    } catch (error) {
        container.innerHTML = errorHTML(error.message);
    }
}

function renderEvents(data) {
    const container = document.getElementById('event-list');

    if (!data.events || data.events.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No events found for the selected filters</p></div>';
        return;
    }

    let html = `
    <table class="data-table">
        <thead>
            <tr>
                <th>Level</th>
                <th>ID</th>
                <th>Source</th>
                <th>Message</th>
                <th>Time</th>
            </tr>
        </thead>
        <tbody>`;

    data.events.forEach(ev => {
        const levelClass = ev.level === 'Error' || ev.level === 'Critical' ? 'badge-danger'
            : ev.level === 'Warning' ? 'badge-warning'
            : 'badge-info';

        html += `
            <tr>
                <td><span class="badge ${levelClass}">${escHtml(ev.level || 'Info')}</span></td>
                <td class="mono">${ev.id}</td>
                <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(ev.source)}">${escHtml(ev.source)}</td>
                <td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(ev.message)}">${escHtml(ev.message)}</td>
                <td class="mono" style="white-space:nowrap">${new Date(ev.timestamp).toLocaleString()}</td>
            </tr>`;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

// ============================================================
// REBOOT ACTIONS (global)
// ============================================================
async function cancelReboot() {
    try {
        const result = await api.cancelReboot();
        if (result.success) {
            showToast('success', 'Pending reboot cancelled');
        } else {
            showToast('error', result.error);
        }
    } catch (error) {
        showToast('error', error.message);
    }
}

// ============================================================
// TOASTS
// ============================================================
function showToast(type, message, duration = 5000) {
    const container = document.getElementById('toast-container');

    const icons = {
        success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <div class="toast-icon">${icons[type]}</div>
        <span class="toast-message">${escHtml(message)}</span>
        <span class="toast-close" onclick="this.parentElement.classList.add('toast-exit');setTimeout(()=>this.parentElement.remove(),250)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
        </span>`;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 250);
    }, duration);
}

// ============================================================
// UTILITIES
// ============================================================
function escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function severityBadge(severity) {
    if (!severity || severity === 'Unspecified') return '';
    const classes = {
        Critical: 'badge-danger',
        Important: 'badge-warning',
        Moderate: 'badge-info',
        Low: 'badge-neutral',
    };
    return `<span class="badge ${classes[severity] || 'badge-neutral'}">${severity}</span>`;
}

function loadingHTML(msg) {
    return `<div class="loading-state"><div class="spinner"></div><p>${msg}</p></div>`;
}

function errorHTML(msg) {
    return `<div class="empty-state" style="color:var(--accent-rose)">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <p>${escHtml(msg)}</p>
    </div>`;
}

function toggleApiKeyVisibility() {
    const input = document.getElementById('api-key');
    input.type = input.type === 'password' ? 'text' : 'password';
}

// ============================================================
// MONITORING / HEARTBEAT
// ============================================================
async function runHeartbeatCheck() {
    if (!state.monitoringStartTime) {
        state.monitoringStartTime = Date.now();
    }

    state.heartbeatChecks++;
    const startTime = performance.now();

    try {
        const result = await api.request('/health');
        const responseTime = Math.round(performance.now() - startTime);

        if (result.success) {
            state.heartbeatSuccesses++;
            state.heartbeatHistory.push({
                timestamp: new Date(),
                online: true,
                responseTime,
                version: result.data?.version,
                agentUptime: result.data?.uptime,
            });
        } else {
            state.heartbeatHistory.push({
                timestamp: new Date(),
                online: false,
                responseTime,
                reason: 'Unhealthy response',
            });
        }
    } catch (error) {
        const responseTime = Math.round(performance.now() - startTime);
        state.heartbeatHistory.push({
            timestamp: new Date(),
            online: false,
            responseTime,
            reason: error.message,
        });
    }

    // Trim history
    if (state.heartbeatHistory.length > state.heartbeatMaxEntries) {
        state.heartbeatHistory = state.heartbeatHistory.slice(-state.heartbeatMaxEntries);
    }

    renderHeartbeatStats();
    renderHeartbeatTimeline();
}

function renderHeartbeatStats() {
    const latest = state.heartbeatHistory[state.heartbeatHistory.length - 1];
    if (!latest) return;

    // Status
    const statusEl = document.getElementById('hb-status');
    if (latest.online) {
        statusEl.innerHTML = '<span style="color:var(--accent-emerald-light)">⬤ Online</span>';
    } else {
        statusEl.innerHTML = '<span style="color:var(--accent-rose-light)">⬤ Offline</span>';
    }

    // Response time
    const rtEl = document.getElementById('hb-response-time');
    if (latest.online) {
        const color = latest.responseTime < 200 ? 'var(--accent-emerald-light)' 
            : latest.responseTime < 500 ? 'var(--accent-amber-light)' 
            : 'var(--accent-rose-light)';
        rtEl.innerHTML = `<span style="color:${color}">${latest.responseTime}ms</span>`;
    } else {
        rtEl.innerHTML = '<span style="color:var(--accent-rose-light)">—</span>';
    }

    // Checks count
    document.getElementById('hb-checks').textContent = state.heartbeatChecks;

    // Uptime percentage
    const uptimeEl = document.getElementById('hb-uptime');
    if (state.heartbeatChecks > 0) {
        const pct = ((state.heartbeatSuccesses / state.heartbeatChecks) * 100).toFixed(1);
        const color = pct >= 99 ? 'var(--accent-emerald-light)' 
            : pct >= 95 ? 'var(--accent-amber-light)' 
            : 'var(--accent-rose-light)';
        uptimeEl.innerHTML = `<span style="color:${color}">${pct}%</span>`;
    }

    // Header status badge
    const headerStatus = document.getElementById('heartbeat-status');
    if (latest.online) {
        headerStatus.innerHTML = '<span class="badge badge-success"><span class="badge-dot"></span>Connected</span>';
    } else {
        headerStatus.innerHTML = '<span class="badge badge-danger"><span class="badge-dot"></span>Unreachable</span>';
    }

    // Timeline range
    const rangeEl = document.getElementById('timeline-range');
    if (state.heartbeatHistory.length > 0) {
        rangeEl.textContent = `${state.heartbeatHistory.length} of ${state.heartbeatMaxEntries} checks`;
    }
}

function renderHeartbeatTimeline() {
    const container = document.getElementById('heartbeat-timeline');
    if (!container) return;

    let html = '';
    const maxEntries = state.heartbeatMaxEntries;

    for (let i = 0; i < maxEntries; i++) {
        const entry = state.heartbeatHistory[i];

        if (!entry) {
            // Pending / no data yet
            html += `<div class="heartbeat-bar pending" style="height:20%">
                <div class="bar-tooltip">Pending</div>
            </div>`;
        } else if (entry.online) {
            // Scale height by response time (lower = taller)
            const maxRt = 1000;
            const normalizedRt = Math.min(entry.responseTime, maxRt);
            const height = Math.max(20, 100 - (normalizedRt / maxRt * 70));
            const time = entry.timestamp.toLocaleTimeString();

            html += `<div class="heartbeat-bar online" style="height:${height}%">
                <div class="bar-tooltip">${time} — ${entry.responseTime}ms</div>
            </div>`;
        } else {
            const time = entry.timestamp.toLocaleTimeString();
            const reason = entry.reason || 'Unknown';

            html += `<div class="heartbeat-bar offline" style="height:100%">
                <div class="bar-tooltip">${time} — ${reason}</div>
            </div>`;
        }
    }

    container.innerHTML = html;
}
