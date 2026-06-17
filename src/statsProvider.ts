import { WebviewProvider } from './webviewProvider';

// Webview provider for the Stats view (placeholder; not yet implemented).
export class StatsProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.statsView';
    protected readonly viewKind = 'stats' as const;
}
