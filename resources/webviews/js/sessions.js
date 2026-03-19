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
        switch (msg.command) { // {command: 'updateSessions', sessions: Session[]}
            case 'updateSessions':
                updateSessions(msg.sessions);
                break;
        }
    });

    function updateSessions(sessions) {
        for (const session of sessions) {
            const sessionElement = document.querySelector('.runtime-entry[data-session-id="' + session.id + '"]');
            const existingDetails = sessionElement.querySelector('.runtime-details');

            const deadMs = 2000;
            const totalMs = 5000;
            const _remStr = Math.ceil(deadMs / 1000) + 's';
            const _reqStr = Math.ceil(totalMs / 1000) + 's';
            const _initText = ci('watch') + ' ' + _remStr + ' / ' + _reqStr;
            const timePart = '<span class="session-countdown-badge" data-deadline="' + deadMs + '" data-total="' + totalMs + '">' + _initText + '</span>';
            const rem = Math.max(0, deadMs - Date.now());
            const pct = totalMs > 0 ? (rem / totalMs) * 100 : 0;
            const progressHtml = '<div class="session-progress-bar"><div class="session-progress-fill" data-deadline="' + deadMs + '" data-total="' + totalMs + '" style="width:' + pct.toFixed(1) + '%"></div></div>';

            const gpuPart = session.gpuClass !== 'None' ? ' <span class="detail-sep">|</span> ' + ci('circuit-board') + ' ' + escapeHtml(session.gpuClass) : '';

            const line1 = ci('server-environment') + ' ' + escapeHtml(session.queue) +
                ' <span class="detail-sep">|</span> ' + ci('account') + ' ' + escapeHtml(session.allocation) +
                ' <span class="detail-sep">|</span> ' + ci('vm') + ' ' + session.cpus +
                ' <span class="detail-sep">|</span> ' + ci('database') + ' ' + session.memory + gpuPart +
                ' <span class="detail-sep">|</span> ' + timePart;

            const line2 = '<span class="session-detail">' + ci('cloud') + ' ' + escapeHtml(session.tunnelId || '') +
                ' <button class="copy-btn" data-copy="' + escapeHtml(session.tunnelUrl) + '" title="Copy tunnel URL">' + ci('copy') + '</button></span>';

            const incActionBtns = [];
            incActionBtns.push('<button class="session-action-main action-stop stop-btn" data-session-id="' + session.id + '">' + ci('debug-stop') + ' Stop</button>');
            incActionBtns.push('<button class="session-action-main action-switch switch-btn session-btn-switch-here" data-session-id="' + session.id + '" data-direction="remote"' + '>' + ci('arrow-swap') + ' Activate</button>');


            const statusLeft = line2 || '';
            const btnsRight = incActionBtns.length > 0 ? '<span class="session-action-btns">' + incActionBtns.join('') + '</span>' : '';
            const actionRowHtml = (statusLeft || btnsRight) ? '<div class="session-action-row">' + statusLeft + btnsRight + '</div>' : '';
            const detailInner = '<span class="session-detail">' + line1 + '</span>' + actionRowHtml;

            // Update or create progress bar
            const existingProgress = sessionElement.querySelector('.session-progress-bar');
            if (progressHtml) {
                if (!existingProgress) {
                    sessionElement.insertAdjacentHTML('afterbegin', progressHtml);
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
                sessionElement.appendChild(div);
            }
        }
    }

})();