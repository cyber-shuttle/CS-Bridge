// The furniture both CyberShuttle-backed views share: the heading that opens a section and the
// panel that stands in for its contents while signed out. `signIn` is handled by the provider, so
// either view can raise it.
import type { ComponentChildren } from 'preact';
import { Row, Stack, Text, Button } from '@/ui/components/base';
import { post } from '@/ui/platform/vscode';

export function SectionHeading({ label, children }: { label: string; children?: ComponentChildren }) {
    return <Row gap={6} pad="2px 0"><Text muted weight={600} size={11}>{label}</Text>{children}</Row>;
}

export function SignInPanel({ note }: { note: string }) {
    return (
        <Stack gap={8} pad="8px 0">
            <Text muted>{note}</Text>
            <Button icon="account" onClick={() => post({ command: 'signIn' })}>Log in to CyberShuttle</Button>
        </Stack>
    );
}
