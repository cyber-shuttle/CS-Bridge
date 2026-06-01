declare module 'posix-getopt' {
    export interface GetoptOption {
        option: string;
        optarg?: string;
        optopt?: string;
    }

    export class BasicParser {
        constructor(optstring: string, argv: string[], optind?: number);
        getopt(): GetoptOption | undefined;
        optind(): number;
    }
}
