export { MetricsCollector } from './collector';
export * from './types';
export { decodeJwtClaims, anonymizeEvents, buildExportDatabase, saveExportFile } from './export';
export type { ExportMetadata } from './export';
export { showConsentModal, syncTelemetry, isTelemetryEnabled, getTelemetryStatusHtml, CONSENT_VERSION } from './telemetry';
export { generateReporterID, submitReport } from './report';
export type { ReportMeta, ReportResult } from './report';
