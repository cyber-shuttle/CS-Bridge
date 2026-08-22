import type { CSSProperties } from 'preact';

type ChipData = { label: string };

const chipStyle: CSSProperties = { padding: '1px 6px', borderRadius: '4px', background: 'var(--vscode-keybindingLabel-background)', color: 'var(--vscode-keybindingLabel-foreground)', border: '1px solid var(--vscode-keybindingLabel-border)', fontSize: '11px', whiteSpace: 'nowrap' };

export function Chip({ label }: ChipData) {
    return <span style={chipStyle}>{label}</span>;
}
