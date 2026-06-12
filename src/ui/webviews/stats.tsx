import { render } from 'preact';
import { Stack, Text } from '@/ui/components/base';

// Placeholder root. Future: list SSH hosts with expandable active/past job history (local-only view).
function Root() {
    return <Stack pad="4px 8px"><Text muted style={{ margin: '2px 0' }}>Coming Soon.</Text></Stack>;
}

render(<Root />, document.getElementById('root')!);
