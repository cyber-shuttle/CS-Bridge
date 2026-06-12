import '@vscode-elements/elements/dist/vscode-progress-ring';
import { px } from '.';

export function Spinner({ size = 14 }: { size?: number }) {
    return <vscode-progress-ring style={{ height: px(size), width: px(size) }}></vscode-progress-ring>;
}
