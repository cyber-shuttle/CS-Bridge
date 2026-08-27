import { render } from "preact";
import { Stack, Text, Button } from "@/ui/components/base";
import { post, useWebviewState } from "@/ui/platform/vscode";
import { CloudProviderState } from "@/models";

function Root() {
  const state = useWebviewState<CloudProviderState>();
  return state ? (
    <Stack
      gap={10}
      pad="14px 16px"
      style={{ maxWidth: "640px", margin: "0 auto" }}
    >
      <Text> Access Key: {state?.accessKey} </Text>
      <Text> Seceret Key: {state?.secretKey} </Text>
      <Text> Session Token: {state?.sessionToken} </Text>

      <Button
        onClick={() => {
          post({ command: "launch" });
        }}
        // disabled={state.accessKey == "" && state.secretKey === ""}
      >
        Launch EC2 Instance
      </Button>
    
      <Button
        onClick={() => {
          post({ command: "rm-key-pair" });
        }}
        // disabled={state.accessKey == "" && state.secretKey === ""}
      >
        Remove Key Pair
      </Button>
    </Stack>
  ) : null;
}

render(<Root />, document.getElementById("root")!);
