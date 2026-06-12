import type { ComponentChildren, CSSProperties } from 'preact';
import { px } from '.';

interface StackProps {
    gap?: number;
    pad?: string;
    style?: CSSProperties;
    children?: ComponentChildren;
}

export function Stack({ gap, pad, style, children }: StackProps) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: px(gap), padding: pad, ...style }}>
            {children}
        </div>
    );
}
