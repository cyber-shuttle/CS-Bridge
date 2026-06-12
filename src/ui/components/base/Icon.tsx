import '@vscode-elements/elements/dist/vscode-icon';
import type { CSSProperties } from 'preact';

export function Icon({ name, title, style }: { name: string; title?: string; style?: CSSProperties }) {
    return <vscode-icon name={name} title={title} style={style}></vscode-icon>;
}
