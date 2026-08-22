import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistableConnectionInfo, SessionConnectionInfo } from '../models';

test('persistableConnectionInfo keeps reattach refs + apiPort and drops secrets/volatile fields', () => {
    const full: SessionConnectionInfo = {
        sshTunnelId: 'tid', sshPort: 40393, region: 'usw3', apiPort: 38157,
        sshTunnelForwardPort: 51000,
        apiTunnelId: 'tid', apiTunnelAccessToken: 'tok',
    };
    assert.deepEqual(persistableConnectionInfo(full), {
        sshTunnelId: 'tid', sshPort: 40393, region: 'usw3', apiPort: 38157,
    });
});

test('persistableConnectionInfo returns undefined only when there is nothing to reattach to', () => {
    assert.equal(persistableConnectionInfo(undefined), undefined);
    assert.equal(persistableConnectionInfo({ sshTunnelId: '', sshPort: 0, region: '' }), undefined);
    // Preparing on the tunnel: no sshd yet, but the pinned apiPort must survive a reload.
    assert.deepEqual(persistableConnectionInfo({ sshTunnelId: '', sshPort: 0, region: 'usw3', apiPort: 25000 }),
        { sshTunnelId: '', sshPort: 0, region: 'usw3', apiPort: 25000 });
});
