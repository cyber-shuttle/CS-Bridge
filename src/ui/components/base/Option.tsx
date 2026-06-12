import '@vscode-elements/elements/dist/vscode-option';
import type { ComponentChildren } from 'preact';

export function Option({ value, children }: { value: string; children?: ComponentChildren }) {
    return <vscode-option value={value}>{children}</vscode-option>;
}
