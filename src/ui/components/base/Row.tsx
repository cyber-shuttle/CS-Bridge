import type { ComponentChildren, CSSProperties } from 'preact';
import { px } from '.';

interface RowProps {
    gap?: number;
    justify?: CSSProperties['justifyContent'];
    wrap?: boolean;
    pad?: string;
    style?: CSSProperties;
    onClick?: (e: Event) => void;
    children?: ComponentChildren;
}

export function Row({ gap, justify, wrap, pad, style, onClick, children }: RowProps) {
    return (
        <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: justify, gap: px(gap), flexWrap: wrap ? 'wrap' : undefined, padding: pad, ...style }}>
            {children}
        </div>
    );
}
