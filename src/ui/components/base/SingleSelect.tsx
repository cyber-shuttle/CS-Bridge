import '@vscode-elements/elements/dist/vscode-single-select';
import type { ComponentChildren, CSSProperties } from 'preact';

export function SingleSelect({ value, onChange, style, disabled, children }: { value: string; onChange: (value: string) => void; style?: CSSProperties; disabled?: boolean; children?: ComponentChildren }) {
    return (
        <vscode-single-select value={value} style={style} disabled={disabled} onChange={(e: Event) => onChange((e.target as HTMLElement & { value: string }).value)}>
            {children}
        </vscode-single-select>
    );
}
