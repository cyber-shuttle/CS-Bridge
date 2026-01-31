import * as vscode from 'vscode';

export class CsStorage {
    secretStorage: vscode.SecretStorage;
    // constructor() {
    public constructor(secretStorage: vscode.SecretStorage) {
        this.secretStorage = secretStorage;
    }

    public async storeAccessToken(token: string): Promise<void> {
        await this.secretStorage.store("access_token", token);
    }   

    public async getAccessToken(): Promise<string | undefined> {
        return await this.secretStorage.get("access_token");
    }

    public async storeRefreshToken(token: string): Promise<void> {
        await this.secretStorage.store("refresh_token", token);
    }   

    public async getRefreshToken(): Promise<string | undefined> {
        return await this.secretStorage.get("refresh_token");
    }
    
    public async storeSecret(key: string, value: string): Promise<void> {
        await this.secretStorage.store(key, value);
    }

    public async getSecret(key: string): Promise<string | undefined> {
        return await this.secretStorage.get(key);
    }

}