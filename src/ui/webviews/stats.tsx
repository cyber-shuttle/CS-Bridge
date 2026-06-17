import { render } from 'preact';
import { Stack, Text } from '@/ui/components/base';

function Root() {
    return <Stack pad="4px 8px"><Text muted style={{ margin: '2px 0' }}>Coming Soon.</Text></Stack>;
}

render(<Root />, document.getElementById('root')!);
