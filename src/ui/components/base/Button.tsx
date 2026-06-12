import '@vscode-elements/elements/dist/vscode-button';
import type { ComponentChildren, CSSProperties } from 'preact';

interface ButtonProps {
    icon?: string;
    secondary?: boolean;
    disabled?: boolean;
    onClick?: (e: Event) => void;
    style?: CSSProperties;
    children?: ComponentChildren;
}

export function Button({ icon, style, children, ...rest }: ButtonProps) {
    return <vscode-button {...rest} icon={icon} style={{ fontSize: '12px', ...style }}>{children}</vscode-button>;
}
