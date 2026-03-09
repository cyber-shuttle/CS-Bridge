// @ts-check
// Storages webview script — communicates with CybershuttleViewProvider via postMessage

(function () {

const vscode = acquireVsCodeApi();
try {

const BROWSE_HOST = document.body.dataset.browseHost || null;

function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// Breadcrumb clicks
document.querySelectorAll('.breadcrumb-seg').forEach(seg => {
    seg.addEventListener('click', () => {
        const action = seg.getAttribute('data-action');
        if (action === 'home') {
            vscode.postMessage({ type: 'storagesGoHome' });
            return;
        }
        if (action === 'host-root' && BROWSE_HOST) {
            vscode.postMessage({ type: 'storagesBrowseDir', host: BROWSE_HOST, path: '~' });
            return;
        }
        const p = seg.getAttribute('data-path');
        if (p && BROWSE_HOST) {
            vscode.postMessage({ type: 'storagesBrowseDir', host: BROWSE_HOST, path: p });
        }
    });
});

// SSH host list clicks (root view)
document.querySelectorAll('#storages-host-list .storage-entry.dir').forEach(entry => {
    entry.addEventListener('click', () => {
        const host = entry.getAttribute('data-host');
        if (host) {
            vscode.postMessage({ type: 'storagesBrowseDir', host: host, path: '~' });
        }
    });
});

// Storage listing messages (when browsing inside a host)
window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'storagesListing') {
        const statusEl = document.getElementById('storages-status');
        const listEl = document.getElementById('storages-list');
        if (!statusEl || !listEl) { return; }

        // Clear all children except the status element
        function clearEntries() {
            Array.from(listEl.children).forEach(ch => {
                if (ch !== statusEl) { ch.remove(); }
            });
        }

        if (msg.loading) {
            statusEl.className = 'storage-status loading';
            const pathDisplay = msg.path || '~';
            statusEl.innerHTML = '<div class="spinner"></div> <span class="loading-path">' + esc(pathDisplay) + '</span>';
            clearEntries();
            return;
        }

        if (msg.error) {
            statusEl.className = 'storage-status error';
            statusEl.textContent = msg.error;
            clearEntries();
            return;
        }

        statusEl.className = 'storage-status';
        statusEl.textContent = '';
        clearEntries();

        if (msg.entries.length === 0) {
            listEl.insertAdjacentHTML('beforeend', '<p class="empty-message">Empty directory</p>');
            return;
        }

        listEl.insertAdjacentHTML('beforeend', msg.entries.map(e => {
            if (e.isDir) {
                return '<div class="storage-entry dir" data-path="' + esc(msg.path + '/' + e.name) + '">'
                    + '<i class="codicon codicon-folder"></i>'
                    + '<span class="storage-name">' + esc(e.name) + '</span>'
                    + '<span class="storage-size">' + esc(e.size) + '</span>'
                    + '</div>';
            } else {
                return '<div class="storage-entry file" data-path="' + esc(msg.path + '/' + e.name) + '">'
                    + '<i class="codicon codicon-file"></i>'
                    + '<span class="storage-name">' + esc(e.name) + '</span>'
                    + '<span class="storage-size">' + esc(e.size) + '</span>'
                    + '</div>';
            }
        }).join(''));

        listEl.querySelectorAll('.storage-entry.dir').forEach(entry => {
            entry.addEventListener('click', () => {
                const p = entry.getAttribute('data-path');
                if (p && BROWSE_HOST) {
                    vscode.postMessage({ type: 'storagesBrowseDir', host: BROWSE_HOST, path: p });
                }
            });
        });
        listEl.querySelectorAll('.storage-entry.file').forEach(entry => {
            entry.addEventListener('click', () => {
                const p = entry.getAttribute('data-path');
                if (p && BROWSE_HOST) {
                    vscode.postMessage({ type: 'storagesOpenFile', host: BROWSE_HOST, path: p });
                }
            });
        });
    }
});

} catch (err) { console.error('[cybershuttle] Storages webview init error:', err); }

})();
