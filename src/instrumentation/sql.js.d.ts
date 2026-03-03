declare module 'sql.js' {
    interface SqlJsStatic {
        Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
    }

    interface Database {
        run(sql: string, params?: (string | number | null | Uint8Array)[]): Database;
        exec(sql: string, params?: (string | number | null | Uint8Array)[]): QueryExecResult[];
        prepare(sql: string, params?: (string | number | null | Uint8Array)[]): Statement;
        export(): Uint8Array;
        close(): void;
    }

    interface Statement {
        step(): boolean;
        getAsObject(): Record<string, unknown>;
        free(): void;
    }

    interface QueryExecResult {
        columns: string[];
        values: unknown[][];
    }

    interface SqlJsOptions {
        wasmBinary?: ArrayLike<number> | Buffer;
        locateFile?: (filename: string) => string;
    }

    export default function initSqlJs(options?: SqlJsOptions): Promise<SqlJsStatic>;
    export { Database, Statement, QueryExecResult, SqlJsStatic };
}
