(function () {

    /** Codicon helper */
    function ci(name) { return '<i class="codicon codicon-' + name + '"></i>'; }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // Wall-time: "HH:MM:SS" -> ms, and ms -> "1h 0m" / "30m 0s" / "45s".
    function wallMs(session) {
        const p = (session.wallTime || '').split(':').map(Number);
        return ((p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0)) * 1000;
    }
    function fmtTime(ms) {
        const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
        return ci('watch') + ' ' + (h ? h + 'h ' + m + 'm' : m + 'm ' + s % 60 + 's');
    }
    // Live remaining-time badge; the 1s interval re-renders it from data-deadline.
    function remainingBadge(session) {
        const total = wallMs(session), d = session.startedAt ? session.startedAt + total : 0;
        return '<span class="session-countdown-badge" data-deadline="' + d + '">' + fmtTime(d ? d - Date.now() : total) + ' remaining</span>';
    }

    setInterval(() => {
        document.querySelectorAll('.session-queued-timer').forEach(el => {
            const submittedAt = parseInt(el.getAttribute('data-submitted'), 10);
            if (!submittedAt) { return; }
            const elapsed = Math.floor((Date.now() - submittedAt) / 1000);
            el.textContent = elapsed >= 60 ? ' (' + Math.floor(elapsed / 60) + 'm ' + (elapsed % 60) + 's)' : ' (' + elapsed + 's)';
        });
        document.querySelectorAll('.session-countdown-badge[data-deadline]').forEach(el => {
            const d = +el.getAttribute('data-deadline');
            if (d) { el.innerHTML = fmtTime(d - Date.now()) + ' remaining'; }
        });
    }, 1000);

    const vscode = acquireVsCodeApi();

    window.addEventListener('message', event => {
        const msg = event.data;
        console.log('Received message from extension:', msg);
        switch (msg.command) {
            case 'slurmClusterInfo':
                updateFormWithClusterInfo(msg.host, msg.clusterInfo);
                break;
            case 'slurmClusterInfoError':
                showFormError(msg.host, msg.message || 'Failed to fetch cluster info.');
                console.error('Error fetching slurm cluster info for host:', msg.host, 'error:', msg.message);
                break;
            case 'sessionUpdate':
                updateSessionDetailsSection(msg.session);
                break;
            case 'prepareLaunchSessionError':
                console.error('Error preparing to launch session: ' + msg.sessionId + ' err: ' + msg.message);
                break;
            case 'launchSessionError':
                console.error('Error launching session: ' + msg.sessionId + ' err: ' + msg.message);
                break;
            case 'scriptPreview':
                showSlurmScriptPreview(msg.session);
                break;
            case 'connectTunnelError':
                console.error('Error connecting tunnel for session: ' + msg.sessionId + ' err: ' + msg.message);
                break;
            default:
                console.warn('Unknown message command:', msg.command);
        }
    });

    // Toggle to host picker visibility
    document.querySelectorAll('.add-session-placeholder').forEach(btn => {
        btn.addEventListener('click', () => {
            const picker = document.getElementById('host-picker');
            if (!picker) { return; }
            const show = picker.style.display === 'none';
            picker.style.display = show ? 'block' : 'none';
            vscode.postMessage({ command: 'setPickerOpen', value: show });
        });
    });

    // Host picker row: toggle form + trigger queryAssociations
    document.querySelectorAll('.host-picker-row').forEach(row => {
        row.addEventListener('click', () => {
            const host = row.getAttribute('data-host');
            const form = getFormForHost(host);
            const chevron = row.querySelector('.host-picker-chevron');
            if (!form) { return; }
            const isExpanding = form.style.display === 'none';
            form.style.display = isExpanding ? 'block' : 'none';
            if (chevron) { chevron.classList.toggle('expanded', isExpanding); }
            vscode.postMessage({ command: 'setHostOpen', host: host, open: isExpanding });
            if (isExpanding) {
                form.querySelector('.job-form-loading').style.display = 'flex';
                form.querySelector('.job-form-fields').style.display = 'none';
                form.querySelector('.job-form-error').style.display = 'none';
                vscode.postMessage({ command: 'fetchSlurmClusterInfo', host: host });
                // Pass to extension to handle and reply with slurmClusterInfo or slurmClusterInfoError
            }
        });
    });

    // "Add SSH Host" row -> open the native input-box flow on the extension host.
    document.querySelectorAll('.add-ssh-host-row').forEach(row => {
        row.addEventListener('click', () => {
            vscode.postMessage({ command: 'addSshHost' });
        });
    });

    // Per-row delete (managed hosts only). stopPropagation so it doesn't toggle the form.
    document.querySelectorAll('.host-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'removeSshHost', name: btn.getAttribute('data-host'), source: btn.getAttribute('data-source') });
        });
    });

    // Add click handlers to provision a session from config view
    document.querySelectorAll('.submit-job-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const host = btn.getAttribute('data-host');
            const form = btn.closest('.host-picker-form');
            if (!form) { return; }
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> Submitting...';
            btn.classList.add('btn-loading');

            const cpus = form.querySelector('[data-field="cpus"]').value;
            const memory = form.querySelector('[data-field="memory"]').value;
            const gpuCount = parseInt(form.querySelector('[data-field="gpuCount"]').value, 10) || 0;
            const gpuTypeEl = form.querySelector('[data-field="gpuType"]');
            const gpuType = gpuTypeEl && !gpuTypeEl.closest('.gpu-type-row').style.display.includes('none') ? gpuTypeEl.value : '';
            const gpu = gpuCount > 0 ? (gpuType ? gpuType + ':' + gpuCount : gpuCount + '') : 'None';
            const wallTime = form.querySelector('[data-field="wallTime"]').value;
            const queue = form.querySelector('[data-field="queue"]').value;
            const allocation = form.querySelector('[data-field="allocation"]').value;
            vscode.postMessage({ command: 'addSession', host: host, cpus: cpus, memory: memory, gpu: gpu, wallTime: wallTime, queue: queue, allocation: allocation });
        });
    });

    document.getElementById('confirm-preview-btn')?.addEventListener('click', () => {
        const previewSessionId = document.getElementById('script-preview-overlay')?.getAttribute('preview-session-id');
        if (previewSessionId && previewSessionId !== '') {
            vscode.postMessage({ command: 'launchSession', sessionId: previewSessionId });
            document.getElementById('script-preview-overlay')?.classList.remove('visible');
            document.getElementById('script-preview-overlay')?.setAttribute('preview-session-id', '');

        }
    });
    // Close script preview overlay (just dismiss; no session state change)
    document.getElementById('cancel-preview-btn')?.addEventListener('click', () => {
        document.getElementById('script-preview-overlay')?.classList.remove('visible');
        document.getElementById('script-preview-overlay')?.setAttribute('preview-session-id', '');
        vscode.postMessage({ command: 'dismissPreview' });
    });


    function showSlurmScriptPreview(session) {
        /*
        <div id="script-preview-overlay" preview-session-id="" class="script-preview-overlay">
            <div class="script-preview-header">SLURM Job Script Preview</div>
            <div id="script-preview-host" class="script-preview-host"></div>
            <div id="script-preview-code" class="script-preview-code"></div>
            <div class="script-preview-actions">
                <button id="cancel-preview-btn" class="cancel-preview-btn">Cancel</button>
                <button id="confirm-preview-btn">Submit Job</button>
            </div>
        </div>
        */
        console.log('Showing Slurm script preview for session:', session);
        document.getElementById('script-preview-host').textContent = 'Host: ' + session.cluster;
        document.getElementById('script-preview-code').textContent = session.batchScript;
        document.getElementById('script-preview-overlay').classList.add('visible');
        // update preview-session-id attribute to session.id so we can correlate if user clicks submit/cancel
        document.getElementById('script-preview-overlay').setAttribute('preview-session-id', session.id);
    }

    // Helper: disable all action buttons in a runtime card
    function disableSessionActions(sessionId) {
        const entry = document.querySelector('.runtime-entry[data-session-id="' + sessionId + '"]');
        if (!entry) { return; }
        entry.querySelectorAll('.session-action-main, .close-session-btn, .dot-action-btn').forEach(b => b.disabled = true);
    }

    function prepareLaunchSession(sessionId) {
        disableSessionActions(sessionId);
        console.log('Requesting preparation to launch session:', sessionId);
        vscode.postMessage({ command: 'prepareLaunchSession', sessionId: sessionId });
    }

    function stopSession(sessionId) {
        disableSessionActions(sessionId);
        console.log('Requesting to stop session:', sessionId);
        vscode.postMessage({ command: 'cancelSessionExecution', sessionId: sessionId });
    }

    function connectTunnel(sessionId) {
        //disableSessionActions(sessionId);
        console.log('Requesting to connect tunnel for session:', sessionId);
        vscode.postMessage({ command: 'connectTunnel', sessionId: sessionId });
    }

    function removeSession(sessionId) {
        disableSessionActions(sessionId);
        vscode.postMessage({ command: 'removeSession', sessionId: sessionId });
    }
    // Delegated click handler for dynamically created start/restart buttons
    document.addEventListener('click', function (e) {

        const btn = e.target.closest('.start-btn');
        if (btn) {
            const sessionId = btn.getAttribute('data-session-id');
            if (sessionId) { prepareLaunchSession(sessionId); }
        }

        const stopButton = e.target.closest('.stop-btn');
        if (stopButton) {
            const sessionId = stopButton.getAttribute('data-session-id');
            if (sessionId) { stopSession(sessionId); }
        }

        const switchBtn = e.target.closest('.switch-btn');
        if (switchBtn) {
            const sessionId = switchBtn.getAttribute('data-session-id');
            if (sessionId) {
                connectTunnel(sessionId);
            }
        }

        const closeBtn = e.target.closest('.close-session-btn');
        if (closeBtn && !closeBtn.disabled) {
            const sessionId = closeBtn.getAttribute('data-session-id');
            if (sessionId) { removeSession(sessionId); }
        }

        const copyBtn = e.target.closest('.copy-btn');
        if (copyBtn) {
            const text = copyBtn.getAttribute('data-copy');
            if (text) { navigator.clipboard?.writeText(text); }
        }

    });

    // Switch dev tunnels auth account
    document.getElementById('auth-switch-btn')?.addEventListener('click', () => {
        console.log('Auth switch button clicked, sending message to extension');
        vscode.postMessage({ command: 'switchAuth' });
    });

    function getFormForHost(host) {
        let foundForm = null;
        document.querySelectorAll('.host-picker-form').forEach(form => {
            const allocSelect = form.querySelector('[data-field="allocation"][data-host="' + host + '"]');
            if (allocSelect) {
                foundForm = form;
            }
        });
        return foundForm;
    }

    function showFormError(host, message) {
        const form = getFormForHost(host);
        if (!form) { return; }
        form.querySelector('.job-form-loading').style.display = 'none';
        form.querySelector('.job-form-fields').style.display = 'none';
        const err = form.querySelector('.job-form-error');
        err.querySelector('.job-form-error-text').textContent = message;
        err.style.display = 'block';
    }

    function updateSessionDetailsSection(session) {

        console.log('Updating session details section for session:', session);
        const sessionCard = document.querySelector('.runtime-entry[data-session-id="' + session.id + '"]');
        if (!sessionCard) { return; }
        sessionCard.style.display = '';
        sessionCard.classList.remove('status-live', 'status-activating', 'status-failed', 'status-idle'); // reset status classes

        let dotClass = 'dot-idle';
        if (['failed', 'cancelled', 'expired'].includes(session.status)) {
            dotClass = 'dot-failed';
            sessionCard.classList.add('status-failed');
        } else if (['pending', 'cancelling', 'submitting', 'deploying_agent'].includes(session.status)) {
            dotClass = 'dot-activating';
            sessionCard.classList.add('status-activating');
        } else if (['running', 'connected'].includes(session.status)) {
            dotClass = 'dot-live';
            sessionCard.classList.add('status-live');
        }

        const canClose = ['failed', 'completed', 'cancelled', 'not_started', 'expired'].includes(session.status);
        const dotCloseHtml = '<button class="dot-action-btn close-session-btn" data-session-id="' + session.id + '"' + (canClose ? '' : ' disabled') + '>' + ci('close') + '</button>';
        const dotHtml = '<span class="dot-action-wrap"><span class="status-dot ' + dotClass + '"></span>' + dotCloseHtml + '</span>';
        const dotWrap = sessionCard.querySelector('.dot-action-wrap');
        if (dotWrap) {
            console.log('Updating session card for session:', session.id, 'status:', session.status, 'dot class:', dotClass);
            dotWrap.outerHTML = dotHtml;
        }

        const nameSpan = sessionCard.querySelector('.runtime-name');
        if (nameSpan) {
            const runtimeLabel = escapeHtml(session.cluster);
            nameSpan.textContent = runtimeLabel;
        }

        const workDir = session.jobDirectory ? escapeHtml(session.jobDirectory) : '';
        let workDirSpan = sessionCard.querySelector('.runtime-workdir');
        console.log('Updating work directory display for session:', session.id, 'workDir:', workDir);
        if (workDir) {

            if (!workDirSpan) {
                console.log('Adding work directory span for session:', session.id, 'workDir:', workDir);
                workDirSpan = document.createElement('span');
                workDirSpan.className = 'runtime-workdir';
                const header = sessionCard.querySelector('.runtime-header');
                const headerRight = sessionCard.querySelector('.runtime-header-right');
                if (header && headerRight) {
                    header.insertBefore(workDirSpan, headerRight);
                }
            }
            workDirSpan.textContent = workDir;
        } else if (workDirSpan) {
            console.log('Removing work directory span for session:', session.id);
            workDirSpan.remove();
        }


        // Update bottom details section
        const existingDetails = sessionCard.querySelector('.runtime-details');

        const timePart = fmtTime(wallMs(session));

        const gpuPart = session.gpuClass !== 'None' ? ' <span class="detail-sep">|</span> ' + ci('circuit-board') + ' ' + escapeHtml(session.gpuClass) : '';

        const line1 = ci('account') + ' ' + escapeHtml(session.allocation) +
            ' <span class="detail-sep">|</span> ' + ci('server-environment') + ' ' + escapeHtml(session.queue) +
            ' <span class="detail-sep">|</span> ' + ci('vm') + ' ' + session.cpus +
            ' <span class="detail-sep">|</span> ' + ci('database') + ' ' + session.memory + gpuPart +
            ' <span class="detail-sep">|</span> ' + timePart;

        let line2 = '';
        // status: 'ready_to_connect' | 'connected' | 'running' | 'failed' | 'completed' | 'pending' | 'submitting' | 'deploying_agent' | 'cancelled' | 'not_started' | 'cancelling' | 'expired' | 'connection_broken';
        // update the bottom left status text based on session.status
        switch (session.status) {
            case 'not_started':
                line2 = '<span class="session-detail">' + ci('circle-slash') + ' not started</span>';
                break;
            case 'ready_to_connect':
                line2 = '<span class="session-detail">' + remainingBadge(session) + '</span>';
                break;
            case 'running':
                line2 = '<span class="session-detail"><span class="spinner"></span> Fetching connection info...</span>';
                break;
            case 'connection_broken':
                line2 = '<span class="session-detail"><span class="spinner"></span> Connection broken, attempting to reconnect...</span>';
                break;
            case 'connecting':
                line2 = '<span class="session-detail"><span class="spinner"></span> Attempting to connect tunnel...</span>';
                break;
            case 'deploying_agent':
                line2 = '<span class="session-detail"><span class="spinner"></span> deploying agent to ' + escapeHtml(session.cluster) + '...</span>';
                break;
            case 'submitting':
                line2 = '<span class="session-detail"><span class="spinner"></span> submitting job...</span>';
                break;
            case 'pending':
                var queuedStr = '';
                console.log('Calculating queued time for session:', session.id, 'submittedAt:', session.submittedAt);
                if (session.submittedAt) {
                    var elapsed = Math.floor((Date.now() - new Date(session.submittedAt).getTime()) / 1000);
                    if (elapsed >= 60) { queuedStr = ' (' + Math.floor(elapsed / 60) + 'm ' + (elapsed % 60) + 's)'; }
                    else { queuedStr = ' (' + elapsed + 's)'; }
                }
                line2 = '<span class="session-detail"><span class="spinner"></span> queued, waiting for resources...<span class="session-queued-timer" data-submitted="' + session.submittedAt + '">' + queuedStr + '</span></span>';
                break;
            case 'cancelling':
                line2 = '<span class="session-detail"><span class="spinner"></span> stopping session...</span>';
                break;
            case 'cancelled':
                line2 = '<span class="session-detail">' + ci('circle-slash') + ' ' + (session.errorMessage ? 'cancel failed: ' + escapeHtml(session.errorMessage) : 'cancelled') + '</span>';
                break;
            case 'failed':
                line2 = '<span class="session-detail"' + (session.errorMessage ? ' title="' + escapeHtml(session.errorMessage) + '"' : '') + '>' + (session.errorMessage ? ci('error') + ' failed: ' + escapeHtml(session.errorMessage) : ci('error') + ' failed') + '</span>';
                break;
            case 'completed':
                line2 = '<span class="session-detail">' + ci('pass') + ' completed</span>';
                break;
            case 'expired':
                line2 = '<span class="session-detail">' + ci('history') + ' expired</span>';
                break;
            case 'connected':
                line2 = '<span class="session-detail">' + remainingBadge(session) + '</span>';
                break;
        }


        const incActionBtns = [];

        if (['failed', 'cancelled', 'expired', 'completed'].includes(session.status)) {
            incActionBtns.push('<button class="session-action-main action-start start-btn" data-session-id="' + session.id + '">' + ci('debug-restart') + ' Restart</button>');
        } else if (['pending', 'cancelling', 'submitting', 'deploying_agent', 'running', 'connection_broken', 'connecting'].includes(session.status)) {
            //incActionBtns.push('<button class="session-action-main btn-loading" disabled><span class="spinner"></span> Activating...</button>');
            incActionBtns.push('<button class="session-action-main action-stop stop-btn" data-session-id="' + session.id + '">' + ci('debug-stop') + ' Stop</button>');
        } else if (session.status === 'connected') {
            incActionBtns.push('<button class="session-action-main action-stop stop-btn" data-session-id="' + session.id + '">' + ci('debug-stop') + ' Stop</button>');
            incActionBtns.push(session.isCurrent
                ? '<button class="session-action-main" disabled>' + ci('check') + ' Current</button>'
                : '<button class="session-action-main action-switch switch-btn" data-session-id="' + session.id + '">' + ci('arrow-swap') + ' ' + (session.windowAlive ? 'Switch' : 'Connect') + '</button>');
        } else if (['ready_to_connect'].includes(session.status)) {
            incActionBtns.push('<button class="session-action-main action-stop stop-btn" data-session-id="' + session.id + '">' + ci('debug-stop') + ' Stop</button>');
            incActionBtns.push('<button class="session-action-main action-switch switch-btn session-btn-switch-here" data-session-id="' + session.id + '" data-direction="remote"' + '>' + ci('arrow-swap') + ' Connect</button>');
        } else if (['not_started'].includes(session.status)) {
            incActionBtns.push('<button class="session-action-main action-start start-btn" data-session-id="' + session.id + '">' + ci('play') + ' Start</button>');
        }

        const statusLeft = line2 || '';
        const btnsRight = incActionBtns.length > 0 ? '<span class="session-action-btns">' + incActionBtns.join('') + '</span>' : '';
        const actionRowHtml = (statusLeft || btnsRight) ? '<div class="session-action-row">' + statusLeft + btnsRight + '</div>' : '';
        const detailInner = '<span class="session-detail">' + line1 + '</span>' + actionRowHtml;

        console.log('Updating session details for session:', session.id, 'status:', session.status, 'detailInner:', detailInner);
        if (existingDetails) {
            existingDetails.innerHTML = detailInner;
        } else {
            const div = document.createElement('div');
            div.className = 'runtime-details';
            div.innerHTML = detailInner;
            sessionCard.appendChild(div);
        }
    }

    function updateFormWithClusterInfo(host, clusterInfo) {
        /*
        {
            host: string;
            accounts: string[];
            partitions: SlurmPartitionInfo[]
        } 
        */
        // if accounts is empty array, show "no accounts" option and hide alloc select
        if (clusterInfo.accounts.length === 0) {
            console.log(`No accounts found for host ${host}`);
            return;
        }

        console.log('Updating account info for host:', host, 'with accounts:', clusterInfo.accounts);
        const form = getFormForHost(host);
        if (form) {
            console.log('Updating form for host:', host, 'with accounts:', clusterInfo.accounts);
            form.querySelector('.job-form-loading').style.display = 'none';
            form.querySelector('.job-form-error').style.display = 'none';
            form.querySelector('.job-form-fields').style.display = 'block';

            const allocSelect = form.querySelector('[data-field="allocation"]');
            const partSelect = form.querySelector('[data-field="queue"]');
            const memorySelect = form.querySelector('[data-field="memory"]');
            const cpuSelect = form.querySelector('[data-field="cpus"]');

            const allocRow = form.querySelector('.alloc-row');
            allocSelect.innerHTML = '';
            if (clusterInfo.accounts.length > 0) {
                if (allocRow) { allocRow.style.display = ''; }
                clusterInfo.accounts.forEach((account) => {
                    const opt = document.createElement('option');
                    opt.value = account;
                    opt.textContent = account;
                    allocSelect.appendChild(opt);
                });
            } else {
                if (allocRow) { allocRow.style.display = 'none'; }
            }

            /*
            export interface SlurmPartitionInfo {
                name: string;
                cpuCount: number;
                memory: string;
                gres: GresInfo[];
            }
            */
            const cpuParts = clusterInfo.partitions.filter(partition => !partition.gres || partition.gres.length === 0);
            const gpuParts = clusterInfo.partitions.filter(partition => partition.gres && partition.gres.length > 0);

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
                const partition = clusterInfo.partitions.find(p => p.name === selPart);
                if (partition === null || partition === undefined) {
                    console.warn('Selected partition not found in cluster info:', selPart);
                    return;
                }
                if (!gpuCountSelect) return;
                if (activeTab === 'gpu' && partition && partition.gres.length > 0) {
                    gpuCountSelect.innerHTML = '';
                    for (let g = 1; g <= partition.gres[0].count; g++) {
                        const opt = document.createElement('option');
                        opt.value = '' + g;
                        opt.textContent = '' + g;
                        if (g === 1) { opt.selected = true; }
                        gpuCountSelect.appendChild(opt);
                    }
                    if (gpuCountRow) { gpuCountRow.style.display = ''; }
                    if (gpuTypeSelect && gpuTypeRow) {
                        gpuTypeSelect.innerHTML = '';
                        partition.gres.forEach(gres => {
                            const opt = document.createElement('option');
                            opt.value = gres.name;
                            opt.textContent = gres.name;
                            gpuTypeSelect.appendChild(opt);
                        });
                        gpuTypeRow.style.display = '';
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
                const partition = clusterInfo.partitions.find(p => p.name === selPart);
                if (partition === null || partition === undefined) {
                    console.warn('Selected partition not found in cluster info:', selPart);
                    return;
                }
                const maxMb = partition ? (partition.memory || 0) : 0;
                const maxGb = Math.floor(maxMb / 1024);
                memorySelect.innerHTML = '';
                if (maxGb <= 0) {
                    [1, 2, 4, 8, 16, 32, 64, 128].forEach(g => {
                        const opt = document.createElement('option');
                        opt.value = g + ' GB'; opt.textContent = g + ' GB';
                        memorySelect.appendChild(opt);
                    });
                    return;
                }
                const steps = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
                const valid = steps.filter(g => g <= maxGb);
                if (valid.length === 0) { valid.push(1); }
                valid.forEach(g => {
                    const opt = document.createElement('option');
                    opt.value = g + ' GB'; opt.textContent = g + ' GB';
                    memorySelect.appendChild(opt);
                });
            }

            function updateCpuOptions() {
                if (!cpuSelect) return;
                const selPart = partSelect.value;
                const partition = clusterInfo.partitions.find(p => p.name === selPart);
                if (partition === null || partition === undefined) {
                    console.warn('Selected partition not found in cluster info:', selPart);
                    return;
                }
                const maxCpus = partition ? partition.cpuCount : 0;
                cpuSelect.innerHTML = '';
                for (let c = 1; c <= maxCpus; c++) {
                    const opt = document.createElement('option');
                    opt.value = '' + c;
                    opt.textContent = '' + c;
                    if (c === 1) { opt.selected = true; }
                    cpuSelect.appendChild(opt);
                }
            }

            function updatePartitions() {
                const filtered = activeTab === 'gpu' ? gpuParts : cpuParts;
                partSelect.innerHTML = '';
                filtered.forEach((partition, i) => {
                    const label = partition.gres.length > 0
                        ? partition.name + ' (' + partition.cpuCount + ' CPUs, ' + partition.gres[0].count + ' GPUs)'
                        : partition.name + ' (' + partition.cpuCount + ' CPUs)';
                    const opt = document.createElement('option');
                    opt.value = partition.name;
                    opt.textContent = label;
                    partSelect.appendChild(opt);
                });
                updateMemoryOptions();
                updateGpuFields();
                updateCpuOptions();
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
            partSelect.addEventListener('change', () => { updateMemoryOptions(); updateGpuFields(); updateCpuOptions(); });
            allocSelect.addEventListener('change', updatePartitions);
        }
    }

})();