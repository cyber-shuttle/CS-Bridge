import type { ComponentChildren, CSSProperties } from 'preact';
import { px } from '.';

interface TextProps {
    muted?: boolean;
    size?: number;
    weight?: number;
    ellipsis?: boolean;
    block?: boolean;
    color?: string;
    title?: string;
    style?: CSSProperties;
    children?: ComponentChildren;
}

export function Text({ muted, size, weight, ellipsis, block, color, title, style, children }: TextProps) {
    return (
        <span title={title} style={{
            display: block ? 'block' : undefined,
            color: color ?? (muted ? 'var(--vscode-descriptionForeground)' : undefined),
            fontSize: px(size),
            fontWeight: weight,
            whiteSpace: ellipsis ? 'nowrap' : undefined,
            overflow: ellipsis ? 'hidden' : undefined,
            textOverflow: ellipsis ? 'ellipsis' : undefined,
            ...style,
        }}>{children}</span>
    );
}
