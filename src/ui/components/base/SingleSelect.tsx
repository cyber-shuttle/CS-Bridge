import '@vscode-elements/elements/dist/vscode-single-select';
import type { ComponentChildren, CSSProperties } from 'preact';

export function SingleSelect({ value, onChange, style, children }: { value: string; onChange: (value: string) => void; style?: CSSProperties; children?: ComponentChildren }) {
    return (
        <vscode-single-select value={value} style={style} onChange={(e: Event) => onChange((e.target as HTMLElement & { value: string }).value)}>
            {children}
        </vscode-single-select>
    );
}
