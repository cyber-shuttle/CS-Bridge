import type { ComponentChildren, CSSProperties } from 'preact';
import { Stack } from './Stack';

export function Card({ children, style }: { children?: ComponentChildren; style?: CSSProperties }) {
    return (
        <Stack gap={3} style={{ border: '1px solid var(--vscode-panel-border)', borderRadius: '6px', padding: '5px 8px', marginBottom: '5px', ...style }}>
            {children}
        </Stack>
    );
}
