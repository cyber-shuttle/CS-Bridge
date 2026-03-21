(function () {

    /** Codicon helper */
    function ci(name) { return '<i class="codicon codicon-' + name + '"></i>'; }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    const vscode = acquireVsCodeApi();

    window.addEventListener('message', event => {
        const msg = event.data;
        console.log('Received message from extension:', msg);
        switch (msg.command) {
            case 'slurmClusterInfo':
                // webView.postMessage({ command: 'slurmClusterInfo', host, clusterInfo });
                const host = msg.host;
                const clusterInfo = msg.clusterInfo;
                updateFormWithClusterInfo(host, clusterInfo);

                break;
            case 'slurmClusterInfoError':
                // Todo: show error message in form
                console.error('Error fetching slurm cluster info for host:', msg.host, 'error:', msg.message);
                break;
            case 'sessionUpdate':
                updateSessionDetailsSection(msg.session);
                break;
        }
    });

    // Toggle to host picker visibility
    document.querySelectorAll('.add-session-placeholder').forEach(btn => {
        btn.addEventListener('click', () => {
            const picker = document.getElementById('host-picker');
            if (picker) {
                const show = picker.style.display === 'none';
                picker.style.display = show ? 'block' : 'none';
            }
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
            if (isExpanding) {
                form.querySelector('.job-form-loading').style.display = 'flex';
                form.querySelector('.job-form-fields').style.display = 'none';
                form.querySelector('.job-form-error').style.display = 'none';
                vscode.postMessage({ command: 'fetchSlurmClusterInfo', host: host });
                // Pass to extension to handle and reply with slurmClusterInfo or slurmClusterInfoError
            }
        });
    });

    // Add click handlers to submit job buttons (workspace host picker only)
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

    function updateSessionDetailsSection(session) {

        const sessionCard = document.querySelector('.runtime-entry[data-session-id="' + session.id + '"]');
        if (!sessionCard) { return; }
        sessionCard.style.display = '';
        sessionCard.classList.remove('status-live', 'status-activating', 'status-failed', 'status-idle'); // reset status classes

        let dotClass = 'dot-idle';
        if (['failed', 'cancelled', 'expired'].includes(session.status)) {
            dotClass = 'dot-failed';
            sessionCard.classList.add('status-failed');
        } else if (['pending', 'cancelling'].includes(session.status)) {
            dotClass = 'dot-activating';
            sessionCard.classList.add('status-activating');
        } else if (['running'].includes(session.status)) {
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