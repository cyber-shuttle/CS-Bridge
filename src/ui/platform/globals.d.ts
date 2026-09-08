import type {} from 'preact';

type VscodeElementProps = Record<string, unknown>;

declare module 'preact' {
    namespace JSX {
        interface IntrinsicElements {
            'vscode-button': VscodeElementProps;
            'vscode-single-select': VscodeElementProps;
            'vscode-option': VscodeElementProps;
            'vscode-icon': VscodeElementProps;
            'vscode-progress-ring': VscodeElementProps;
        }
    }
}
