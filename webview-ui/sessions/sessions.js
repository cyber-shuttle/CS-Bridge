// @ts-check
// Sessions webview script — communicates with CybershuttleViewProvider via postMessage

(function () {

    /** Codicon helper */
    function ci(name) { return '<i class="codicon codicon-' + name + '"></i>'; }

    function displayWorkDir(rawPath) {
        if (rawPath === '~' || rawPath.startsWith('~/')) {
            return rawPath === '~' ? '$CS_HOME' : '$CS_HOME/' + rawPath.slice(2);
        }
        return rawPath;
    }

const vscode = acquireVsCodeApi();

// Live countdown timer + progress bar for active runtimes
function updateCountdowns() {
    const pad = (n) => String(n).padStart(2, '0');
    document.querySelectorAll('.session-countdown-badge[data-deadline]').forEach(el => {
        const deadline = parseInt(el.getAttribute('data-deadline'), 10);
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            el.innerHTML = ci('watch') + ' expired';
            el.className = 'session-countdown-badge countdown-critical';
            const card = el.closest('.runtime-entry');
            if (card) {
                card.classList.remove('status-live', 'status-activating', 'status-failed');
                card.classList.add('status-idle');
                const stopBtns = card.querySelectorAll('.stop-btn');
                stopBtns.forEach(b => b.remove());
                const sessionId = card.getAttribute('data-session-id');
                if (sessionId && !el.getAttribute('data-expired-notified')) {
                    el.setAttribute('data-expired-notified', '1');
                    vscode.postMessage({ type: 'sessionExpired', sessionId: sessionId });
                }
            }
        } else {
            const totalMs = parseInt(el.getAttribute('data-total'), 10) || 0;
            function fmtTime(ms) {
                const s = Math.floor(ms / 1000);
                const h = Math.floor(s / 3600);
                const m = Math.floor((s % 3600) / 60);
                if (h > 0) return h + ':' + pad(m) + ':' + pad(s % 60);
                return pad(m) + ':' + pad(s % 60);
            }
            const remStr = fmtTime(remaining);
            const reqStr = fmtTime(totalMs);
            el.innerHTML = ci('watch') + ' ' + remStr + ' / ' + reqStr;
            const remainMin = remaining / 60000;
            if (remainMin <= 5) {
                el.className = 'session-countdown-badge countdown-critical';
            } else if (remainMin <= 15) {
                el.className = 'session-countdown-badge countdown-warning';
            } else {
                el.className = 'session-countdown-badge';
            }
        }
    });
    // Update progress bars
    document.querySelectorAll('.session-progress-fill[data-deadline]').forEach(bar => {
        const deadline = parseInt(bar.getAttribute('data-deadline'), 10);
        const total = parseInt(bar.getAttribute('data-total'), 10);
        const remaining = Math.max(0, deadline - Date.now());
        const pct = total > 0 ? (remaining / total) * 100 : 0;
        bar.style.width = pct.toFixed(1) + '%';
        const totalMin = remaining / 60000;
        bar.classList.remove('progress-warning', 'progress-critical');
        if (remaining <= 0 || totalMin <= 5) {
            bar.classList.add('progress-critical');
        } else if (totalMin <= 15) {
            bar.classList.add('progress-warning');
        }
    });
    // Update queued timers
    document.querySelectorAll('.session-queued-timer[data-submitted]').forEach(el => {
        const submitted = el.getAttribute('data-submitted');
        if (!submitted) return;
        var elapsed = Math.floor((Date.now() - new Date(submitted).getTime()) / 1000);
        if (elapsed >= 60) { el.textContent = ' (' + Math.floor(elapsed / 60) + 'm ' + (elapsed % 60) + 's)'; }
        else { el.textContent = ' (' + elapsed + 's)'; }
    });
}
updateCountdowns();
setInterval(updateCountdowns, 1000);
try {

// Add click handlers to submit job buttons (workspace host picker only)
document.querySelectorAll('.submit-job-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const host = btn.getAttribute('data-host');
        const wsId = btn.getAttribute('data-workspace-id');
        const form = btn.closest('.host-picker-form');
        if (!form) { return; }
        const noSlurm = btn.hasAttribute('data-no-slurm');
        const syncModeEl = form.querySelector('[data-field="syncMode"]');
        const syncMode = syncModeEl ? syncModeEl.value : 'stage';
        if (noSlurm) {
            vscode.postMessage({ type: 'addRuntime', host: host, cpus: '1', memory: '1 GB', gpu: 'None', wallTime: '01:00:00', queue: '', allocation: '', workspaceId: wsId, noSlurm: true, syncMode: syncMode });
            return;
        }
        const cpus = form.querySelector('[data-field="cpus"]').value;
        const memory = form.querySelector('[data-field="memory"]').value;
        const gpuCount = parseInt(form.querySelector('[data-field="gpuCount"]').value, 10) || 0;
        const gpuTypeEl = form.querySelector('[data-field="gpuType"]');
        const gpuType = gpuTypeEl && !gpuTypeEl.closest('.gpu-type-row').style.display.includes('none') ? gpuTypeEl.value : '';
        const gpu = gpuCount > 0 ? (gpuType ? gpuType + ':' + gpuCount : gpuCount + '') : 'None';
        const wallTime = form.querySelector('[data-field="wallTime"]').value;
        const queue = form.querySelector('[data-field="queue"]').value;
        const allocation = form.querySelector('[data-field="allocation"]').value;
        vscode.postMessage({ type: 'addRuntime', host: host, cpus: cpus, memory: memory, gpu: gpu, wallTime: wallTime, queue: queue, allocation: allocation, workspaceId: wsId, syncMode: syncMode });
    });
});

// Host picker row: toggle form + trigger queryAssociations
document.querySelectorAll('.host-picker-row').forEach(row => {
    row.addEventListener('click', () => {
        const host = row.getAttribute('data-host');
        const wsId = row.getAttribute('data-workspace-id');
        const formId = 'host-form-' + wsId + '-' + host;
        const form = document.getElementById(formId);
        const chevron = row.querySelector('.host-picker-chevron');
        if (!form) { return; }
        const isExpanding = form.style.display === 'none';
        form.style.display = isExpanding ? 'block' : 'none';
        if (chevron) { chevron.classList.toggle('expanded', isExpanding); }
        if (isExpanding) {
            form.querySelector('.job-form-loading').style.display = 'flex';
            form.querySelector('.job-form-fields').style.display = 'none';
            form.querySelector('.job-form-error').style.display = 'none';
            vscode.postMessage({ type: 'queryAssociations', host: host });
        }
    });
});

// Helper: disable all action buttons in a runtime card
function disableSessionActions(sessionId) {
    const entry = document.querySelector('.runtime-entry[data-session-id="' + sessionId + '"]');
    if (!entry) { return; }
    entry.querySelectorAll('.session-action-main, .close-session-btn, .dot-action-btn').forEach(b => b.disabled = true);
}

// Add click handlers to session switch buttons (extracted for re-attachment after incremental updates)
function attachSwitchHandlers() {
    document.querySelectorAll('.switch-btn').forEach(btn => {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', () => {
            const sessionId = newBtn.getAttribute('data-session-id');
            const direction = newBtn.getAttribute('data-direction');
            disableSessionActions(sessionId);
            newBtn.innerHTML = '<span class="spinner"></span> Activating...';
            newBtn.classList.add('btn-loading');
            if (direction === 'local-window') {
                vscode.postMessage({ type: 'switchToWindow', sessionId: sessionId });
            } else if (direction === 'remote') {
                vscode.postMessage({ type: 'switchToRemote', sessionId: sessionId });
            } else {
                vscode.postMessage({ type: 'switchToLocal', sessionId: sessionId });
            }
        });
    });
}
attachSwitchHandlers();

// Add click handlers to start (relaunch) buttons
function attachStartHandlers() {
    document.querySelectorAll('.start-btn').forEach(btn => {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', () => {
            const sessionId = newBtn.getAttribute('data-session-id');
            disableSessionActions(sessionId);
            vscode.postMessage({ type: 'relaunchSession', sessionId: sessionId });
        });
    });
}
attachStartHandlers();

// Add session placeholder click → toggle host picker
document.querySelectorAll('.add-session-placeholder').forEach(btn => {
    btn.addEventListener('click', () => {
        const wsId = btn.getAttribute('data-workspace-id');
        const picker = document.getElementById('host-picker-' + wsId);
        if (picker) {
            const show = picker.style.display === 'none';
            picker.style.display = show ? 'block' : 'none';
        }
    });
});

// Add click handlers to stop (cancel SLURM job) buttons
function attachStopHandlers() {
    document.querySelectorAll('.stop-btn').forEach(btn => {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', () => {
            const sessionId = newBtn.getAttribute('data-session-id');
            disableSessionActions(sessionId);
            vscode.postMessage({ type: 'stopRemote', sessionId: sessionId });
        });
    });
}
attachStopHandlers();

// Add click handlers to restart-linkspan, start-linkspan, and stop-linkspan buttons
// Linkspan button handlers — use event delegation so dynamically created buttons always work
document.addEventListener('click', function (e) {
    var btn = e.target.closest('.action-start-linkspan, .action-stop-linkspan, .action-restart-linkspan');
    if (!btn || btn.disabled) { return; }
    var sessionId = btn.getAttribute('data-session-id');
    btn.disabled = true;
    if (btn.classList.contains('action-start-linkspan')) {
        btn.innerHTML = '<span class="spinner"></span> Starting...';
        btn.classList.add('btn-loading');
        vscode.postMessage({ type: 'startLinkspan', sessionId: sessionId });
    } else if (btn.classList.contains('action-stop-linkspan')) {
        btn.innerHTML = '<span class="spinner"></span> Stopping...';
        btn.classList.add('btn-loading');
        vscode.postMessage({ type: 'stopLinkspan', sessionId: sessionId });
    } else if (btn.classList.contains('action-restart-linkspan')) {
        btn.innerHTML = '<span class="spinner"></span> Restarting...';
        btn.classList.add('btn-loading');
        vscode.postMessage({ type: 'restartLinkspan', sessionId: sessionId });
    }
});
function attachLinkspanHandlers() { /* now handled by event delegation above */ }

// Add click handlers to copy-to-clipboard buttons
function attachCopyHandlers() {
    document.querySelectorAll('.copy-btn').forEach(btn => {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const text = newBtn.getAttribute('data-copy');
            if (text) {
                vscode.postMessage({ type: 'copyToClipboard', text: text });
            }
        });
    });
}
attachCopyHandlers();

// Add click handlers to session close buttons (extracted for re-attachment after incremental updates)
function attachCloseHandlers() {
    document.querySelectorAll('.close-session-btn').forEach(btn => {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', () => {
            const sessionId = newBtn.getAttribute('data-session-id');
            disableSessionActions(sessionId);
            vscode.postMessage({ type: 'closeSession', sessionId: sessionId });
        });
    });
}
attachCloseHandlers();

// Script preview state
let previewSessionId = null;

document.getElementById('confirm-preview-btn')?.addEventListener('click', () => {
    if (previewSessionId) {
        vscode.postMessage({ type: 'confirmJob', sessionId: previewSessionId });
        document.getElementById('script-preview-overlay')?.classList.remove('visible');
        previewSessionId = null;
    }
});

document.getElementById('cancel-preview-btn')?.addEventListener('click', () => {
    if (previewSessionId) {
        vscode.postMessage({ type: 'cancelJob', sessionId: previewSessionId });
    }
    document.getElementById('script-preview-overlay')?.classList.remove('visible');
    previewSessionId = null;
});

// Handle messages from the extension (e.g. associations data, script preview)
window.addEventListener('message', event => {
    const msg = event.data;

    if (msg.type === 'scriptPreview') {
        previewSessionId = msg.sessionId;
        document.getElementById('script-preview-host').textContent = 'Host: ' + msg.host;
        document.getElementById('script-preview-code').textContent = msg.script;
        document.getElementById('script-preview-overlay').classList.add('visible');
        return;
    }

    if (msg.type === 'scriptPreviewDismissed') {
        document.getElementById('script-preview-overlay').classList.remove('visible');
        previewSessionId = null;
        return;
    }

    if (msg.type === 'associationsCancelled') {
        const allForms = getAllFormsForHost(msg.host);
        allForms.forEach(form => {
            form.querySelector('.job-form-loading').style.display = 'none';
        });
        return;
    }

    if (msg.type === 'associationsError') {
        const allForms = getAllFormsForHost(msg.host);
        allForms.forEach(form => {
            form.querySelector('.job-form-loading').style.display = 'none';
            form.querySelector('.job-form-error').style.display = 'flex';
            form.querySelector('.job-form-error-text').textContent = 'Failed to fetch partitions: ' + msg.error;
        });
        return;
    }

    function getAllFormsForHost(host) {
        const forms = [];
        document.querySelectorAll('.host-picker-form').forEach(form => {
            const allocSelect = form.querySelector('[data-field="allocation"][data-host="' + host + '"]');
            if (allocSelect) { forms.push(form); }
        });
        return forms;
    }

    if (msg.type === 'associations') {
        const host = msg.host;
        const partitions = msg.partitions;
        const savedPrefs = msg.savedPrefs || {};
        const allForms = getAllFormsForHost(host);

        const allPartNames = Object.keys(partitions);
        const accountSet = new Set();
        for (const info of Object.values(partitions)) {
            for (const acct of info.accounts) { accountSet.add(acct); }
        }
        const accounts = Array.from(accountSet).sort();

        const isSlurm = allPartNames.length > 0;

        allForms.forEach(form => {
            form.querySelector('.job-form-loading').style.display = 'none';
            form.querySelector('.job-form-error').style.display = 'none';
            form.querySelector('.job-form-fields').style.display = 'block';

            if (!isSlurm) {
                form.querySelectorAll('.resource-tabs, .alloc-row, .form-row').forEach(el => {
                    el.style.display = 'none';
                });
                form.querySelector('.submit-job-btn').setAttribute('data-no-slurm', '1');
                return;
            }

            const allocSelect = form.querySelector('[data-field="allocation"]');
            const partSelect = form.querySelector('[data-field="queue"]');
            const memorySelect = form.querySelector('[data-field="memory"]');

            const allocRow = form.querySelector('.alloc-row');
            allocSelect.innerHTML = '';
            if (accounts.length > 0) {
                if (allocRow) { allocRow.style.display = ''; }
                accounts.forEach((acct, i) => {
                    const opt = document.createElement('option');
                    opt.value = acct;
                    opt.textContent = acct;
                    if (savedPrefs.allocation ? acct === savedPrefs.allocation : i === 0) { opt.selected = true; }
                    allocSelect.appendChild(opt);
                });
            } else {
                if (allocRow) { allocRow.style.display = 'none'; }
            }

            const cpuParts = allPartNames.filter(n => !partitions[n].maxGpus || partitions[n].maxGpus === 0);
            const gpuParts = allPartNames.filter(n => partitions[n].maxGpus > 0);

            const gpuTab = form.querySelector('.resource-tab[data-tab="gpu"]');
            const cpuTab = form.querySelector('.resource-tab[data-tab="cpu"]');
            const hasCpu = cpuParts.length > 0;
            const hasGpu = gpuParts.length > 0;
            if (cpuTab) { cpuTab.style.display = hasCpu ? '' : 'none'; }
            if (gpuTab) { gpuTab.style.display = hasGpu ? '' : 'none'; }

            const gpuCountRow = document.querySelector('.gpu-count-row[data-host="' + host + '"]');
            const gpuCountSelect = document.querySelector('[data-field="gpuCount"][data-host="' + host + '"]');
            const gpuTypeRow = document.querySelector('.gpu-type-row[data-host="' + host + '"]');
            const gpuTypeSelect = document.querySelector('[data-field="gpuType"][data-host="' + host + '"]');

            let activeTab = hasCpu ? 'cpu' : 'gpu';

            function updateGpuFields() {
                const selPart = partSelect.value;
                const info = partitions[selPart];
                if (!gpuCountSelect) return;
                if (activeTab === 'gpu' && info && info.maxGpus > 0) {
                    gpuCountSelect.innerHTML = '';
                    for (let g = 1; g <= info.maxGpus; g++) {
                        const opt = document.createElement('option');
                        opt.value = '' + g;
                        opt.textContent = '' + g;
                        if (g === 1) { opt.selected = true; }
                        gpuCountSelect.appendChild(opt);
                    }
                    if (gpuCountRow) { gpuCountRow.style.display = ''; }
                    if (gpuTypeSelect && gpuTypeRow) {
                        gpuTypeSelect.innerHTML = '';
                        if (info.gpuTypes && info.gpuTypes.length > 0) {
                            info.gpuTypes.forEach(t => {
                                const opt = document.createElement('option');
                                opt.value = t;
                                opt.textContent = t;
                                gpuTypeSelect.appendChild(opt);
                            });
                            gpuTypeRow.style.display = '';
                        } else {
                            gpuTypeRow.style.display = 'none';
                        }
                    }
                } else {
                    gpuCountSelect.innerHTML = '<option value="0">None</option>';
                    if (gpuCountRow) { gpuCountRow.style.display = 'none'; }
                    if (gpuTypeRow) { gpuTypeRow.style.display = 'none'; }
                }
            }

            function updateMemoryOptions() {
                if (!memorySelect) return;
                const selPart = partSelect.value;
                const info = partitions[selPart];
                const maxMb = info ? (info.maxMemMb || 0) : 0;
                const maxGb = Math.floor(maxMb / 1024);
                memorySelect.innerHTML = '';
                if (maxGb <= 0) {
                    [1,2,4,8,16,32,64,128].forEach(g => {
                        const opt = document.createElement('option');
                        opt.value = g + ' GB'; opt.textContent = g + ' GB';
                        memorySelect.appendChild(opt);
                    });
                    return;
                }
                const steps = [1,2,4,8,16,32,64,128,256,512,1024];
                const valid = steps.filter(g => g <= maxGb);
                if (valid.length === 0) { valid.push(1); }
                valid.forEach(g => {
                    const opt = document.createElement('option');
                    opt.value = g + ' GB'; opt.textContent = g + ' GB';
                    memorySelect.appendChild(opt);
                });
            }

            function updatePartitions() {
                const filtered = activeTab === 'gpu' ? gpuParts : cpuParts;
                partSelect.innerHTML = '';
                filtered.forEach((name, i) => {
                    const info = partitions[name];
                    const label = info.maxGpus > 0
                        ? name + ' (' + info.nodes + ' Nodes, ' + info.maxCpus + ' CPUs, ' + info.maxGpus + ' GPUs)'
                        : name + ' (' + info.nodes + ' Nodes, ' + info.maxCpus + ' CPUs)';
                    const opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = label;
                    if (savedPrefs.partition ? name === savedPrefs.partition : i === 0) { opt.selected = true; }
                    partSelect.appendChild(opt);
                });
                updateMemoryOptions();
                updateGpuFields();
            }

            function switchTab(tab) {
                activeTab = tab;
                form.querySelectorAll('.resource-tab').forEach(t => {
                    t.classList.toggle('active', t.getAttribute('data-tab') === tab);
                });
                updatePartitions();
            }

            if (cpuTab) { cpuTab.addEventListener('click', () => switchTab('cpu')); }
            if (gpuTab) { gpuTab.addEventListener('click', () => switchTab('gpu')); }
            switchTab(activeTab);
            partSelect.addEventListener('change', () => { updateMemoryOptions(); updateGpuFields(); });
            allocSelect.addEventListener('change', updatePartitions);
        });
    }

    if (msg.type === 'updateRuntimes') {
        function escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }
        const isRemoteWindow = !!msg.isRemoteWindow;
        const linkspanRunning = !!msg.linkspanRunning;
        const updates = msg.updates;
        for (const wsUpdate of updates) {
            for (const rt of wsUpdate.runtimes) {
                const entry = document.querySelector('.runtime-entry[data-session-id="' + rt.id + '"]');
                if (!entry) { continue; }

                // Toggle disabled state on remote sessions when linkspan is stopped
                if (!rt.isLocal) {
                    entry.classList.toggle('linkspan-stopped', !linkspanRunning);
                }

                // Check if expired
                const isRemoteActiveEarly = rt.status === 'Active' && !rt.isLocal;
                let isExpiredNow = false;
                if (isRemoteActiveEarly && rt.submittedAt && rt.wallTime) {
                    const wtP = rt.wallTime.split(':').map(Number);
                    const wtM = (wtP[0] || 0) * 60 + (wtP[1] || 0);
                    const dlMs = new Date(rt.submittedAt).getTime() + wtM * 60000;
                    isExpiredNow = Date.now() >= dlMs;
                }

                // Update active-session and status class on the card
                const isThisWinCard = rt.isThisWindow || rt.isActiveInThisWindow;
                entry.classList.toggle('active-session', isThisWinCard);
                entry.classList.remove('status-live', 'status-activating', 'status-failed', 'status-idle');
                const isRemoteReady = rt.status === 'Active' && !!rt.tunnelUrl;
                const localLinkspanUp = rt.status === 'Local' && !!rt.linkspanInfo;
                const isLive = localLinkspanUp || (!rt.isLocal && rt.isActiveInThisWindow) || isRemoteReady;
                const isLiveNow = isRemoteReady || localLinkspanUp;
                const isActivatingNow = rt.status === 'Starting local anchor' || rt.status === 'Deploying agent' || rt.status === 'Submitting' || rt.status === 'Pending' || (rt.status === 'Active' && !rt.tunnelUrl);
                const isRemoteActiveNow = rt.status === 'Active' && !rt.isLocal;
                const isRunningNow = isRemoteActiveNow && !isExpiredNow;
                const isSwitching = !!rt.switching;
                let dotClass = 'dot-idle';
                if (isSwitching) {
                    entry.classList.add('status-activating');
                    dotClass = 'dot-activating';
                } else if (isLive && !isExpiredNow) {
                    entry.classList.add('status-live');
                    dotClass = 'dot-live';
                } else if (rt.status === 'Starting local anchor' || rt.status === 'Deploying agent' || rt.status === 'Submitting' || rt.status === 'Pending' || (rt.status === 'Active' && !rt.tunnelUrl)) {
                    entry.classList.add('status-activating');
                    dotClass = 'dot-activating';
                } else if (rt.status === 'Failed') {
                    entry.classList.add('status-failed');
                    dotClass = 'dot-failed';
                } else {
                    entry.classList.add('status-idle');
                }
                // Update dot + dot-action (always wrapped)
                const dotWrap = entry.querySelector('.dot-action-wrap');
                let dotBtnHtml = '';
                if (!rt.isLocal) {
                    const canClose = !isRunningNow && !isActivatingNow && !isLiveNow && !isSwitching;
                    dotBtnHtml = '<button class="dot-action-btn close-session-btn" data-session-id="' + rt.id + '"' + (canClose ? '' : ' disabled') + '>' + ci('close') + '</button>';
                }
                const newDotHtml = '<span class="dot-action-wrap"><span class="status-dot ' + dotClass + '"></span>' + dotBtnHtml + '</span>';
                if (dotWrap) {
                    dotWrap.outerHTML = newDotHtml;
                }

                // Update runtime name + working directory
                const nameSpan = entry.querySelector('.runtime-name');
                if (nameSpan) {
                    const runtimeLabel = rt.status === 'Local' ? 'Local' : escapeHtml(rt.host);
                    nameSpan.textContent = runtimeLabel;
                }
                const rawWorkDir = rt.status === 'Local'
                    ? (wsUpdate.workspacePath || '')
                    : (rt.connectedRemotePath || rt.localWorkdir || '');
                const workDir = displayWorkDir(rawWorkDir);
                let workDirSpan = entry.querySelector('.runtime-workdir');
                if (workDir) {
                    if (!workDirSpan) {
                        workDirSpan = document.createElement('span');
                        workDirSpan.className = 'runtime-workdir';
                        const header = entry.querySelector('.runtime-header');
                        const headerRight = entry.querySelector('.runtime-header-right');
                        if (header && headerRight) {
                            header.insertBefore(workDirSpan, headerRight);
                        }
                    }
                    workDirSpan.textContent = workDir;
                } else if (workDirSpan) {
                    workDirSpan.remove();
                }

                // Update action buttons
                const isThisWin = rt.isThisWindow || rt.isActiveInThisWindow;
                const headerRight = entry.querySelector('.runtime-header-right');
                if (headerRight) {
                    headerRight.innerHTML = '';
                }

                // Update detail / action section
                const existingDetails = entry.querySelector('.runtime-details');
                if (rt.status === 'Local') {
                    // Local card: show linkspan status + action buttons
                    var detailInner = '';
                    if (rt.linkspanInfo) {
                        var statsHtml = '<span class="session-detail">'
                            + ci('pulse') + ' ' + rt.linkspanInfo.pid
                            + ' <span class="detail-sep">|</span> ' + ci('server-process') + ' :' + rt.linkspanInfo.serverPort
                            + ' <span class="detail-sep">|</span> ' + ci('terminal') + ' :' + rt.linkspanInfo.sshPort
                            + '</span>';
                        var statusLeft = '';
                        if (rt.linkspanInfo.tunnelId) {
                            statusLeft = '<span class="session-status-text">'
                                + ci('cloud') + ' ' + escapeHtml(rt.linkspanInfo.tunnelId)
                                + (rt.linkspanInfo.tunnelUrl ? ' <button class="copy-btn" data-copy="' + escapeHtml(rt.linkspanInfo.tunnelUrl) + '" title="Copy tunnel URL">' + ci('copy') + '</button>' : '')
                                + '</span>';
                        }
                        var localBtns = [];
                        if (!isRemoteWindow) {
                            localBtns.push('<button class="session-action-main action-stop-linkspan" data-session-id="' + rt.id + '"><i class="codicon codicon-debug-stop"></i>Stop</button>');
                            localBtns.push('<button class="session-action-main action-restart-linkspan" data-session-id="' + rt.id + '"><i class="codicon codicon-debug-restart"></i>Restart</button>');
                        }
                        var btnsRight = localBtns.length > 0 ? '<span class="session-action-btns">' + localBtns.join('') + '</span>' : '';
                        var actionRow = '<div class="session-action-row">' + statusLeft + btnsRight + '</div>';
                        detailInner = statsHtml + actionRow;
                    } else {
                        var statusLeft = '';
                        var localBtns = [];
                        if (!isRemoteWindow) {
                            statusLeft = '<span class="session-status-text">Linkspan is stopped. Start it to enable remote access.</span>';
                            localBtns.push('<button class="session-action-main action-start-linkspan" data-session-id="' + rt.id + '"><i class="codicon codicon-play"></i>Start</button>');
                        }
                        if (isRemoteWindow && !isThisWin && !isSwitching) {
                            localBtns.push('<button class="session-action-main action-switch switch-btn" data-session-id="' + rt.id + '" data-direction="local"><i class="codicon codicon-arrow-swap"></i>Activate</button>');
                        }
                        var btnsRight = localBtns.length > 0 ? '<span class="session-action-btns">' + localBtns.join('') + '</span>' : '';
                        var actionRow = (statusLeft || btnsRight) ? '<div class="session-action-row">' + statusLeft + btnsRight + '</div>' : '';
                        detailInner = actionRow;
                    }
                    if (detailInner) {
                        if (existingDetails) {
                            existingDetails.innerHTML = detailInner;
                        } else {
                            var div = document.createElement('div');
                            div.className = 'runtime-details';
                            div.innerHTML = detailInner;
                            entry.appendChild(div);
                        }
                    } else if (existingDetails) {
                        existingDetails.remove();
                    }
                } else {
                    const wtParts = rt.wallTime.split(':').map(Number);
                    const wtTotalMin = (wtParts[0] || 0) * 60 + (wtParts[1] || 0);
                    const wallTimeShort = wtTotalMin >= 1440 ? Math.floor(wtTotalMin / 1440) + 'd' : wtTotalMin >= 60 ? Math.floor(wtTotalMin / 60) + 'hr' : wtTotalMin + 'min';
                    const gpuPart = rt.gpu !== 'None' ? ' <span class="detail-sep">|</span> ' + ci('circuit-board') + ' ' + escapeHtml(rt.gpu) : '';
                    // Time: countdown if active, static walltime otherwise
                    let timePart = '';
                    let progressHtml = '';
                    if (isRemoteActiveNow && rt.submittedAt) {
                        const deadMs = new Date(rt.submittedAt).getTime() + wtTotalMin * 60000;
                        const totalMs = wtTotalMin * 60000;
                        const _rem = deadMs - Date.now();
                        let _initText = ci('watch') + ' expired';
                        if (_rem > 0) {
                            const _s = Math.floor(_rem / 1000), _h = Math.floor(_s / 3600), _m = Math.floor((_s % 3600) / 60), _ss = _s % 60;
                            const _p = (n) => String(n).padStart(2, '0');
                            const _remStr = _h > 0 ? _h + ':' + _p(_m) + ':' + _p(_ss) : _p(_m) + ':' + _p(_ss);
                            const _ts = Math.floor(totalMs / 1000), _th = Math.floor(_ts / 3600), _tm = Math.floor((_ts % 3600) / 60);
                            const _reqStr = _th > 0 ? _th + ':' + _p(_tm) + ':' + _p(_ts % 60) : _p(_tm) + ':' + _p(_ts % 60);
                            _initText = ci('watch') + ' ' + _remStr + ' / ' + _reqStr;
                        }
                        timePart = '<span class="session-countdown-badge" data-deadline="' + deadMs + '" data-total="' + totalMs + '">' + _initText + '</span>';
                        const rem = Math.max(0, deadMs - Date.now());
                        const pct = totalMs > 0 ? (rem / totalMs) * 100 : 0;
                        progressHtml = '<div class="session-progress-bar"><div class="session-progress-fill" data-deadline="' + deadMs + '" data-total="' + totalMs + '" style="width:' + pct.toFixed(1) + '%"></div></div>';
                    } else {
                        timePart = ci('watch') + ' ' + wallTimeShort;
                    }
                    const line1 = ci('server-environment') + ' ' + escapeHtml(rt.queue) + ' <span class="detail-sep">|</span> ' + ci('account') + ' ' + escapeHtml(rt.allocation) + ' <span class="detail-sep">|</span> ' + ci('vm') + ' ' + rt.cpus + ' <span class="detail-sep">|</span> ' + ci('database') + ' ' + rt.memory + gpuPart + ' <span class="detail-sep">|</span> ' + timePart;
                    let line2 = '';
                    if (rt.status === 'Active') {
                        if (rt.tunnelUrl) {
                            line2 = '<span class="session-detail">' + ci('cloud') + ' ' + escapeHtml(rt.tunnelId || '') + ' <button class="copy-btn" data-copy="' + escapeHtml(rt.tunnelUrl) + '" title="Copy tunnel URL">' + ci('copy') + '</button></span>';
                        } else {
                            line2 = '<span class="session-detail"><span class="spinner"></span> setting up tunnel...</span>';
                        }
                    } else if (rt.status === 'Deploying agent') {
                        line2 = '<span class="session-detail"><span class="spinner"></span> deploying agent to ' + escapeHtml(rt.host) + '...</span>';
                    } else if (rt.status === 'Submitting') {
                        line2 = '<span class="session-detail"><span class="spinner"></span> submitting job...</span>';
                    } else if (rt.status === 'Pending') {
                        var queuedStr = '';
                        if (rt.submittedAt) {
                            var elapsed = Math.floor((Date.now() - new Date(rt.submittedAt).getTime()) / 1000);
                            if (elapsed >= 60) { queuedStr = ' (' + Math.floor(elapsed / 60) + 'm ' + (elapsed % 60) + 's)'; }
                            else { queuedStr = ' (' + elapsed + 's)'; }
                        }
                        line2 = '<span class="session-detail"><span class="spinner"></span> queued, waiting for resources...<span class="session-queued-timer" data-submitted="' + rt.submittedAt + '">' + queuedStr + '</span></span>';
                    } else if (rt.status === 'Failed') {
                        line2 = '<span class="session-detail">' + (rt.errorMessage ? ci('error') + ' failed: ' + escapeHtml(rt.errorMessage) : ci('error') + ' failed') + '</span>';
                    } else if (rt.status === 'Completed') {
                        line2 = '<span class="session-detail">' + ci('pass') + ' completed</span>';
                    }
                    const incActionBtns = [];
                    if (isSwitching) {
                        incActionBtns.push('<button class="session-action-main btn-loading" disabled><span class="spinner"></span> Activating...</button>');
                    } else if (isRunningNow || isActivatingNow) {
                        incActionBtns.push('<button class="session-action-main action-stop stop-btn" data-session-id="' + rt.id + '">' + ci('debug-stop') + ' Stop</button>');
                        if (!isThisWin) {
                            const activateDisabled = !isLiveNow;
                            incActionBtns.push('<button class="session-action-main action-switch switch-btn session-btn-switch-here" data-session-id="' + rt.id + '" data-direction="remote"' + (activateDisabled ? ' disabled' : '') + '>' + ci('arrow-swap') + ' Activate</button>');
                        }
                    }
                    if (!isSwitching && !isRunningNow && !isActivatingNow && !isLiveNow && !rt.isLocal) {
                        const hasRun = rt.status === 'Completed' || rt.status === 'Failed';
                        const label = hasRun ? ci('debug-restart') + ' Restart' : ci('play') + ' Start';
                        incActionBtns.push('<button class="session-action-main action-start start-btn" data-session-id="' + rt.id + '">' + label + '</button>');
                    }
                    // When in a remote window, show Activate for other live remote sessions
                    if (!isSwitching && isRemoteWindow && !isThisWin && isLiveNow) {
                        incActionBtns.push('<button class="session-action-main action-switch switch-btn session-btn-switch-here" data-session-id="' + rt.id + '" data-direction="remote">' + ci('arrow-swap') + ' Activate</button>');
                    }
                    const statusLeft = line2 || '';
                    const btnsRight = incActionBtns.length > 0 ? '<span class="session-action-btns">' + incActionBtns.join('') + '</span>' : '';
                    const actionRowHtml = (statusLeft || btnsRight) ? '<div class="session-action-row">' + statusLeft + btnsRight + '</div>' : '';
                    const detailInner = '<span class="session-detail">' + line1 + '</span>'
                        + actionRowHtml;

                    // Update or create progress bar
                    const existingProgress = entry.querySelector('.session-progress-bar');
                    if (progressHtml) {
                        if (!existingProgress) {
                            entry.insertAdjacentHTML('afterbegin', progressHtml);
                        }
                    } else if (existingProgress) {
                        existingProgress.remove();
                    }

                    if (existingDetails) {
                        existingDetails.innerHTML = detailInner;
                    } else {
                        const div = document.createElement('div');
                        div.className = 'runtime-details';
                        div.innerHTML = detailInner;
                        entry.appendChild(div);
                    }
                }
            }
        }

        // Re-attach event listeners for any new buttons injected during the update
        attachSwitchHandlers();
        attachStartHandlers();
        attachStopHandlers();
        attachCloseHandlers();
        attachLinkspanHandlers();
        attachCopyHandlers();
    }
});
} catch (err) { console.error('[cybershuttle] Webview init error:', err); }

})();
