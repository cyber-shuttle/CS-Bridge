import { WebviewProvider } from './webviewProvider';

// Webview provider for the Stats view. Skeleton — the view renders a "Coming Soon" placeholder and has no
// messages or pushed state yet; session-statistics logic will live here.
export class StatsProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.statsView';
    protected readonly viewKind = 'stats' as const;
}
