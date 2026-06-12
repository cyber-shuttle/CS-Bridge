import '@vscode-elements/elements/dist/vscode-icon';

export function ActionIcon({ name, title, ariaLabel, size, onClick }: { name: string; title?: string; ariaLabel?: string; size?: number; onClick?: (e: Event) => void }) {
    return <vscode-icon name={name} action-icon title={title} aria-label={ariaLabel} size={size} style={{ marginLeft: 'auto' }} onClick={onClick}></vscode-icon>;
}
