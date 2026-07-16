// values → SVG polyline points (max at top; optional domain fixes the y-range). slots fixes the x-grid to a capacity
// ≥ values.length so a filling buffer grows in from the left then slides; omit it to spread values full-width.
export function sparklinePoints(values: number[], width: number, height: number, domain?: [number, number], slots?: number): string {
    const min = domain?.[0] ?? Math.min(...values);
    const span = (domain?.[1] ?? Math.max(...values)) - min;
    const denom = (slots ?? values.length) - 1;
    const stepX = denom > 0 ? width / denom : 0;
    const r = (n: number) => Math.round(n * 10) / 10;
    return values.map((v, i) => `${r(i * stepX)},${r(span === 0 ? height / 2 : height - ((v - min) / span) * height)}`).join(' ');
}
