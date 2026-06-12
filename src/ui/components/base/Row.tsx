import type { ComponentChildren, CSSProperties } from 'preact';
import { px } from '.';

interface RowProps {
    gap?: number;
    justify?: CSSProperties['justifyContent'];
    wrap?: boolean;
    pad?: string;
    style?: CSSProperties;
    children?: ComponentChildren;
}

export function Row({ gap, justify, wrap, pad, style, children }: RowProps) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: justify, gap: px(gap), flexWrap: wrap ? 'wrap' : undefined, padding: pad, ...style }}>
            {children}
        </div>
    );
}
