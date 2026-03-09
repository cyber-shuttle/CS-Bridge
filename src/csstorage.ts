import * as vscode from 'vscode';

export class CsStorage {
    secretStorage: vscode.SecretStorage;
    public constructor(secretStorage: vscode.SecretStorage) {
        this.secretStorage = secretStorage;
    }

    public async getAccessToken(): Promise<string | undefined> {
        return await this.secretStorage.get("access_token");
    }
}
