import { render } from 'preact';
import { Stack, Text, Button } from '@/ui/components/base';
import { post, useWebviewState } from '@/ui/platform/vscode';
import { CloudProviderState } from '@/models';

function Root() {

    const state = useWebviewState<CloudProviderState>();
    return state ? (
        <Stack gap={10} pad="14px 16px" style={{ maxWidth: '640px', margin: '0 auto' }}>
            <Text> AWS Access Key: {state?.accessKey} </Text>
            <Text> AWS Seceret Key: {state?.secretKey} </Text>
            <Button
                onClick={() => {
                    post({ command: "launch" })
                }}
                //disabled={state.accessKey == "" && state.secretKey === ""}
            >
                Launch EC2 Instance
            </Button>

        </Stack>
    ) : null
}

render(<Root />, document.getElementById('root')!);

