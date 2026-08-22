import type { ComponentChildren } from 'preact';
import { Stack } from './Stack';

export function Card({ children }: { children?: ComponentChildren }) {
    return (
        <Stack gap={3} style={{ border: '1px solid var(--vscode-panel-border)', borderRadius: '6px', padding: '5px 8px', marginBottom: '5px' }}>
            {children}
        </Stack>
    );
}
