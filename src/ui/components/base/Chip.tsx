import type { CSSProperties } from 'preact';

type ChipData = { label: string; title?: string };

const chipStyle: CSSProperties = { padding: '1px 6px', borderRadius: '4px', background: 'var(--vscode-keybindingLabel-background)', color: 'var(--vscode-keybindingLabel-foreground)', border: '1px solid var(--vscode-keybindingLabel-border)', fontSize: '11px', whiteSpace: 'nowrap' };

export function Chip({ label, title }: ChipData) {
    return <span title={title} style={chipStyle}>{label}</span>;
}
